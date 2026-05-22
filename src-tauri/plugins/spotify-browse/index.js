// Spotify Browse Plugin for Viboplr
// Opens open.spotify.com in an internal browse window, navigates to configurable
// sections, and scrapes all playlists and their tracks from the rendered DOM.

function activate(api) {
  var activeScrapeHandle = null;
  var scrapeGeneration = 0;
  var pendingSectionInput = "";

  var state = {
    currentView: "home",
    // idle | waiting-login | finding-section | scraping-playlists |
    // scraping-tracks | done | error
    status: "idle",
    playlists: [],
    playlistTracks: {},   // playlistId -> [{ name, artist, album, duration, imageUrl, spotifyId }]
    previousTracks: {},   // playlistId -> tracks from before last refresh
    currentPlaylist: null,
    scrapeProgress: { current: 0, total: 0, name: "", found: 0 },
    errorMessage: "",
    activeTab: "section:Made for You",
    lastLoginCheck: null,
    updatedPlaylistIds: {},
    refreshing: false,
    showBrowserOnRefresh: false,
    autoRefreshHours: 24,
    lastCheckAt: null,
    lastCheckResult: null,
    refreshSummary: "",
    sections: ["Made for You"],
    addingSectionViaTab: false,
    lastReport: null,
    showDiagnostics: false,
    // Per-playlist search query (only used in the detail view). Keyed by
    // playlist id so navigating away and back keeps the query.
    playlistSearch: {},
  };

  // ---- Helpers ----

  // Liked Songs is /collection/tracks — a fixed-URL collection rather than a
  // section of playlists. Treat it as a synthetic single-playlist "section" so
  // it slots into the existing section/playlist/tracks pipeline.
  var LIKED_SECTION = "Liked Songs";
  var LIKED_PLAYLIST_ID = "__liked_songs__";

  function isLikedSection(name) {
    return String(name || "").toLowerCase() === LIKED_SECTION.toLowerCase();
  }

  function makeLikedPlaylist() {
    return {
      id: LIKED_PLAYLIST_ID,
      name: LIKED_SECTION,
      section: LIKED_SECTION,
      description: "Your saved tracks on Spotify.",
      imageUrl: null,
      uri: "spotify://collection/tracks",
    };
  }

  // The Liked Songs page has no real cover — Spotify renders a purple gradient
  // with a heart icon. og:image points at a generic Spotify image. Generate a
  // matching SVG locally and write it to the playlist's directory so the card
  // gets the familiar look without round-tripping to the network.
  var LIKED_COVER_SVG =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">' +
    '<defs>' +
    '<linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">' +
    '<stop offset="0%" stop-color="#4A0080"/>' +
    '<stop offset="100%" stop-color="#A0C0FF"/>' +
    '</linearGradient>' +
    '</defs>' +
    '<rect width="300" height="300" fill="url(#g)"/>' +
    '<path d="M150 230 C150 230, 80 185, 80 130 C80 105, 100 85, 125 85 C140 85, 150 95, 150 95 C150 95, 160 85, 175 85 C200 85, 220 105, 220 130 C220 185, 150 230, 150 230 Z" fill="#FFFFFF"/>' +
    '</svg>';

  // Write Liked Songs cover SVG to disk if missing. Returns the resolved file path.
  function ensureLikedCover(pl) {
    var dir = playlistDir(pl);
    var svgPath = dir.concat(["cover.svg"]);
    return api.storage.files.exists(svgPath).then(function (has) {
      if (has) return api.storage.files.getPath(svgPath);
      return api.storage.files.writeText(svgPath, LIKED_COVER_SVG)
        .then(function () { return api.storage.files.getPath(svgPath); });
    }).then(function (p) {
      if (p) pl.imageUrl = p;
      return p;
    }).catch(function (e) {
      console.error("Failed to write Liked Songs cover:", e);
      return null;
    });
  }

  function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ---- Diagnostics: unified logger + run report ----

  var MAX_REPORT_LOG_ENTRIES = 500;
  var MAX_STORED_REPORTS = 5;
  var activeReport = null;

  function plog(level, tag, msg, data) {
    var line = "[" + tag + "] " + msg;
    if (data !== undefined) line += " " + safeStringify(data);
    if (level === "error") console.error("[spotify]", line);
    else if (level === "warn") console.warn("[spotify]", line);
    else console.log("[spotify]", line);
    api.log(level, line, "spotify-browse");
    if (activeReport) {
      activeReport.log.push({ ts: Date.now(), level: level, tag: tag, msg: msg, data: data });
      if (activeReport.log.length > MAX_REPORT_LOG_ENTRIES) {
        activeReport.log.splice(0, activeReport.log.length - MAX_REPORT_LOG_ENTRIES);
      }
      appendSyncLine(level, tag, msg, data);
    }
  }

  // Human-readable "last_sync.log" accumulator. Lines are appended in order as
  // the sync progresses and persisted to plugin storage on finishReport().
  function appendSyncLine(level, tag, msg, data) {
    if (!activeReport) return;
    if (!activeReport.formattedLog) activeReport.formattedLog = [];
    var ts = new Date().toISOString();
    var lvl = (level || "info").toUpperCase();
    var line = ts + " [" + lvl + "] [" + tag + "] " + msg;
    if (data !== undefined) line += " " + safeStringify(data);
    activeReport.formattedLog.push(line);
  }

  // Convenience: append a free-form info line without going through plog (used
  // for high-level sync summaries we want in the log but not in the live UI).
  function syncNote(tag, msg, data) {
    appendSyncLine("info", tag, msg, data);
  }

  function dbg(tag, msg, data) { plog("info", tag, msg, data); }

  function safeStringify(v) {
    try { return typeof v === "string" ? v : JSON.stringify(v); }
    catch (e) { return "[unstringifiable]"; }
  }

  function beginReport(trigger, sectionsToScrape) {
    activeReport = {
      trigger: trigger,
      startedAt: new Date().toISOString(),
      endedAt: null,
      durationMs: 0,
      outcome: "running",
      errorMessage: null,
      sections: sectionsToScrape.map(function (n) {
        return { name: n, status: "pending", attempts: 0, playlistCount: 0, snapshot: null };
      }),
      playlists: [],
      log: [],
      // Detailed sync trace (persisted as last_sync.log)
      formattedLog: [],
      pageVisits: [],   // [{url, phase, ts}]
      imageHits: [],    // [{kind, playlistId, playlistName, url, rule, element}]
      ruleStats: {},    // ruleKey -> { ok, fail }
    };
    syncNote("sync", "=== Spotify sync started ===", {
      trigger: trigger,
      sections: sectionsToScrape,
    });
  }

  function recordPageVisit(url, phase) {
    if (!activeReport || !url) return;
    activeReport.pageVisits.push({ url: url, phase: phase || "", ts: Date.now() });
  }

  function recordImageHit(entry) {
    if (!activeReport) return;
    activeReport.imageHits.push(entry);
  }

  function recordRuleOutcome(ruleKey, ok) {
    if (!activeReport || !ruleKey) return;
    if (!activeReport.ruleStats[ruleKey]) activeReport.ruleStats[ruleKey] = { ok: 0, fail: 0 };
    if (ok) activeReport.ruleStats[ruleKey].ok++;
    else activeReport.ruleStats[ruleKey].fail++;
  }

  function buildLastSyncLog(report) {
    var lines = [];
    lines.push("=== Spotify Sync Log ===");
    lines.push("Trigger: " + (report.trigger || "?"));
    lines.push("Started: " + report.startedAt);
    lines.push("Ended: " + (report.endedAt || "?"));
    lines.push("Duration: " + Math.round((report.durationMs || 0) / 1000) + "s (" + report.durationMs + "ms)");
    lines.push("Outcome: " + report.outcome + (report.errorMessage ? " — " + report.errorMessage : ""));
    lines.push("");

    // Sections summary
    lines.push("--- Sections ---");
    for (var i = 0; i < (report.sections || []).length; i++) {
      var s = report.sections[i];
      lines.push("  " + s.name + ": " + s.status +
        " (attempts=" + (s.attempts || 0) + ", playlists=" + (s.playlistCount || 0) + ")");
    }
    lines.push("");

    // Playlists summary
    var totalTracks = 0;
    var okPl = 0, emptyPl = 0, errPl = 0, timeoutPl = 0;
    lines.push("--- Playlists (" + (report.playlists || []).length + ") ---");
    for (var p = 0; p < (report.playlists || []).length; p++) {
      var pl = report.playlists[p];
      totalTracks += (pl.trackCount || 0);
      if (pl.status === "ok") okPl++;
      else if (pl.status === "empty") emptyPl++;
      else if (pl.status === "error") errPl++;
      else if (pl.status === "timeout") timeoutPl++;
      lines.push("  [" + pl.status + "] " + (pl.name || "?") +
        " (id=" + pl.id + ", section=" + (pl.section || "?") + ")" +
        " — " + (pl.trackCount || 0) + " tracks in " + Math.round((pl.durationMs || 0) / 1000) + "s" +
        (pl.error ? " — error: " + pl.error : ""));
    }
    lines.push("");
    lines.push("  Totals: " + totalTracks + " tracks across " + (report.playlists || []).length +
      " playlists (ok=" + okPl + ", empty=" + emptyPl + ", error=" + errPl + ", timeout=" + timeoutPl + ")");
    lines.push("");

    // Pages visited
    lines.push("--- Pages visited (" + (report.pageVisits || []).length + ") ---");
    for (var v = 0; v < (report.pageVisits || []).length; v++) {
      var pv = report.pageVisits[v];
      lines.push("  [" + (pv.phase || "?") + "] " + pv.url);
    }
    lines.push("");

    // Images discovered
    lines.push("--- Images retrieved (" + (report.imageHits || []).length + ") ---");
    for (var im = 0; im < (report.imageHits || []).length; im++) {
      var h = report.imageHits[im];
      var label = "  [" + (h.kind || "?") + "]";
      if (h.playlistName) label += " " + h.playlistName + " (" + (h.playlistId || "?") + ")";
      label += " rule=" + (h.rule || "?");
      if (h.element) label += " element=" + h.element;
      label += " url=" + (h.url ? String(h.url).substring(0, 200) : "(none)");
      lines.push(label);
    }
    lines.push("");

    // Rule stats
    lines.push("--- Rule outcomes ---");
    var ruleKeys = Object.keys(report.ruleStats || {});
    if (ruleKeys.length === 0) {
      lines.push("  (no rule outcomes recorded)");
    } else {
      ruleKeys.sort();
      for (var rk = 0; rk < ruleKeys.length; rk++) {
        var key = ruleKeys[rk];
        var st = report.ruleStats[key];
        lines.push("  " + key + ": ok=" + (st.ok || 0) + " fail=" + (st.fail || 0));
      }
    }
    lines.push("");

    // Per-section snapshots (if any captured for failures)
    var hasSnap = false;
    for (var ss = 0; ss < (report.sections || []).length; ss++) {
      if (report.sections[ss].snapshot) { hasSnap = true; break; }
    }
    if (!hasSnap) {
      for (var ps = 0; ps < (report.playlists || []).length; ps++) {
        if (report.playlists[ps].snapshot) { hasSnap = true; break; }
      }
    }
    if (hasSnap) {
      lines.push("--- Failure snapshots ---");
      for (var sx = 0; sx < (report.sections || []).length; sx++) {
        var sec = report.sections[sx];
        if (sec.snapshot) {
          lines.push("  section '" + sec.name + "' snapshot:");
          lines.push("    url: " + (sec.snapshot.url || "?"));
          lines.push("    title: " + (sec.snapshot.title || "?"));
          lines.push("    counts: " + safeStringify(sec.snapshot.counts || {}));
          if (sec.snapshot.testids) {
            lines.push("    testids (top 20): " + sec.snapshot.testids.slice(0, 20).join(", "));
          }
        }
      }
      for (var px = 0; px < (report.playlists || []).length; px++) {
        var pp = report.playlists[px];
        if (pp.snapshot) {
          lines.push("  playlist '" + (pp.name || "?") + "' (" + pp.id + ") snapshot:");
          lines.push("    url: " + (pp.snapshot.url || "?"));
          lines.push("    counts: " + safeStringify(pp.snapshot.counts || {}));
          if (pp.snapshot.testids) {
            lines.push("    testids (top 20): " + pp.snapshot.testids.slice(0, 20).join(", "));
          }
        }
      }
      lines.push("");
    }

    // Full ordered trace
    lines.push("--- Trace (" + (report.formattedLog || []).length + " lines) ---");
    for (var fl = 0; fl < (report.formattedLog || []).length; fl++) {
      lines.push(report.formattedLog[fl]);
    }

    return lines.join("\n");
  }

  function getReportSection(name) {
    if (!activeReport) return null;
    for (var i = 0; i < activeReport.sections.length; i++) {
      if (activeReport.sections[i].name === name) return activeReport.sections[i];
    }
    return null;
  }

  function finishReport(outcome, errorMessage) {
    if (!activeReport) return;
    activeReport.endedAt = new Date().toISOString();
    activeReport.durationMs = new Date(activeReport.endedAt).getTime() - new Date(activeReport.startedAt).getTime();
    activeReport.outcome = outcome;
    if (errorMessage) activeReport.errorMessage = errorMessage;
    syncNote("sync", "=== Spotify sync finished ===", {
      outcome: outcome,
      errorMessage: errorMessage || null,
      durationMs: activeReport.durationMs,
    });
    var snapshot = activeReport;
    activeReport = null;
    persistReport(snapshot);
    persistLastSyncLog(snapshot);
  }

  function persistLastSyncLog(report) {
    try {
      var text = buildLastSyncLog(report);
      api.storage.set("last_sync.log", text).catch(function (e) {
        console.error("Failed to write last_sync.log:", e);
      });
    } catch (e) {
      console.error("Failed to build last_sync.log:", e);
    }
  }

  function persistReport(report) {
    api.storage.get("spotify_browse_reports").then(function (existing) {
      var list = Array.isArray(existing) ? existing.slice() : [];
      list.unshift(report);
      if (list.length > MAX_STORED_REPORTS) list.length = MAX_STORED_REPORTS;
      api.storage.set("spotify_browse_reports", list).catch(function (e) {
        console.error("Failed to save spotify report:", e);
      });
      state.lastReport = report;
      renderSettings();
    }).catch(function (e) { console.error("Failed to read reports:", e); });
  }

  // ---- Change detection helpers ----

  function tracksChanged(oldTracks, newTracks) {
    if (!oldTracks || oldTracks.length !== newTracks.length) return true;
    var oldSet = {};
    for (var i = 0; i < oldTracks.length; i++) {
      oldSet[oldTracks[i].name + "\0" + oldTracks[i].artist] = true;
    }
    for (var j = 0; j < newTracks.length; j++) {
      if (!oldSet[newTracks[j].name + "\0" + newTracks[j].artist]) return true;
    }
    return false;
  }

  function getDiff(playlistId) {
    var prev = state.previousTracks[playlistId];
    var curr = state.playlistTracks[playlistId];
    if (!prev || !curr) return { added: [], removed: [] };

    var prevSet = {};
    for (var i = 0; i < prev.length; i++) {
      prevSet[prev[i].name + "\0" + prev[i].artist] = prev[i];
    }
    var currSet = {};
    for (var j = 0; j < curr.length; j++) {
      currSet[curr[j].name + "\0" + curr[j].artist] = curr[j];
    }

    var added = [];
    for (var k = 0; k < curr.length; k++) {
      var key = curr[k].name + "\0" + curr[k].artist;
      if (!prevSet[key]) added.push(curr[k]);
    }
    var removed = [];
    for (var m = 0; m < prev.length; m++) {
      var rkey = prev[m].name + "\0" + prev[m].artist;
      if (!currSet[rkey]) removed.push(prev[m]);
    }

    return { added: added, removed: removed };
  }

  function sectionsEqual(a, b) {
    return String(a || "Playlists").toLowerCase() === String(b || "Playlists").toLowerCase();
  }

  function getPlaylistsForSection(sectionName) {
    var result = [];
    for (var i = 0; i < state.playlists.length; i++) {
      if (sectionsEqual(state.playlists[i].section, sectionName)) {
        result.push(state.playlists[i]);
      }
    }
    return result;
  }

  // ---- Filesystem persistence ----
  // Layout: playlists/{section}/{playlist_id}/{meta.json,tracks.json,previous.json,cover.jpg,track-*.jpg}

  function djb2Hash(str) {
    var hash = 5381;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & 0xFFFFFFFF;
    }
    var hex = (hash >>> 0).toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  // Section names can contain characters that are awkward on disk. Normalize
  // (but keep spaces, letters, digits, and common punctuation Spotify uses).
  function sanitizeSegment(s) {
    if (!s) return "_";
    var out = String(s).replace(/[/\\\0]/g, "_").replace(/[\x00-\x1f]/g, "").trim();
    if (!out) return "_";
    if (out.length > 200) out = out.substring(0, 200);
    return out;
  }

  function playlistDir(pl) {
    return ["playlists", sanitizeSegment(pl.section || "Playlists"), sanitizeSegment(pl.id)];
  }

  function serializeTracks(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      out.push({
        name: t.name || "",
        artist: t.artist || "",
        album: t.album || "",
        duration: t.duration || "",
        spotifyId: t.spotifyId || null,
        coverFile: t.coverFile || null,
        imageUrl: t.imageUrl && t.imageUrl.indexOf("http") === 0 ? t.imageUrl : null,
      });
    }
    return out;
  }

  // Persist a single playlist's files. Returns a promise that resolves when
  // meta + tracks are on disk and images are being fetched (images run in
  // the background and the promise settles independently from their success).
  function savePlaylist(pl) {
    var dir = playlistDir(pl);
    var tracks = state.playlistTracks[pl.id] || [];

    var coverFile = pl.id === LIKED_PLAYLIST_ID ? "cover.svg" : "cover.jpg";
    var metaP = api.storage.files.writeJson(dir.concat(["meta.json"]), {
      id: pl.id,
      name: pl.name,
      section: pl.section || null,
      description: pl.description || "",
      coverFile: coverFile,
      coverVersion: pl.coverVersion || null,
      lastCheckedAt: pl.lastCheckedAt || null,
      updatedAt: pl.updatedAt || null,
    }).catch(function (e) { console.error("Failed to write meta:", pl.id, e); });

    var tracksP = api.storage.files.writeJson(dir.concat(["tracks.json"]), serializeTracks(tracks))
      .catch(function (e) { console.error("Failed to write tracks:", pl.id, e); });

    return Promise.all([metaP, tracksP]);
  }

  function saveAllPlaylists() {
    var promises = [];
    for (var i = 0; i < state.playlists.length; i++) {
      promises.push(savePlaylist(state.playlists[i]));
    }
    return Promise.all(promises);
  }

  // Download cover + track images into each playlist's directory, updating
  // track.imageUrl / pl.imageUrl to absolute local paths. Idempotent — skips
  // fetches for images already local.
  function cacheAllImages() {
    var promises = [];
    var stats = { covers: 0, tracks: 0, coverFails: 0, trackFails: 0 };
    for (var pi = 0; pi < state.playlists.length; pi++) {
      (function (pl) {
        var dir = playlistDir(pl);
        if (pl.id === LIKED_PLAYLIST_ID) {
          promises.push(ensureLikedCover(pl));
          // Liked Songs has no remote cover to fetch; track images are still
          // handled via the standard path below.
        } else if (pl.imageUrl && pl.imageUrl.indexOf("http") === 0) {
          stats.covers++;
          var coverUrl = pl.imageUrl;
          promises.push(
            api.storage.files.download(dir.concat(["cover.jpg"]), coverUrl).then(function (path) {
              // Bump coverVersion so the WebView refetches the file even though
              // the on-disk path is unchanged. Without this, weekly-rotating
              // covers (Discover Weekly) keep showing last week's image.
              pl.coverVersion = Date.now();
              pl.imageUrl = path + "#v=" + pl.coverVersion;
            }).catch(function (e) {
              stats.coverFails++;
              api.log("warn", "Failed to cache playlist cover for " + pl.name + ": " + e + " | url: " + coverUrl.substring(0, 120));
              pl.imageUrl = null;
            })
          );
        }
        var tracks = state.playlistTracks[pl.id] || [];
        for (var ti = 0; ti < tracks.length; ti++) {
          (function (track) {
            if (track.imageUrl && track.imageUrl.indexOf("http") === 0) {
              stats.tracks++;
              var trackUrl = track.imageUrl;
              var filename = "track-" + djb2Hash(track.name + " - " + track.artist) + ".jpg";
              promises.push(
                api.storage.files.download(dir.concat([filename]), trackUrl).then(function (path) {
                  track.imageUrl = path;
                  track.coverFile = filename;
                }).catch(function (e) {
                  stats.trackFails++;
                  api.log("warn", "Failed to cache track image (" + track.name + "): " + e + " | url: " + trackUrl.substring(0, 120));
                  track.imageUrl = null;
                  track.coverFile = null;
                })
              );
            }
          })(tracks[ti]);
        }
      })(state.playlists[pi]);
    }

    if (promises.length > 0) {
      dbg("images", "Caching " + stats.covers + " covers + " + stats.tracks + " track images");
      Promise.all(promises).then(function () {
        if (stats.coverFails || stats.trackFails) {
          api.log("warn", "Image cache complete: " + stats.coverFails + "/" + stats.covers + " covers failed, " + stats.trackFails + "/" + stats.tracks + " tracks failed");
        } else {
          dbg("images", "All images cached successfully (" + stats.covers + " covers, " + stats.tracks + " tracks)");
        }
        saveAllPlaylists();
        render();
      }).catch(function () {
        saveAllPlaylists();
      });
    }
  }

  function saveState() {
    saveAllPlaylists().catch(console.error);
  }

  // Walk playlists/** and load every {section, id, meta, tracks}. Resolves
  // track coverFile references to absolute paths for rendering.
  function loadPlaylistsFromDisk() {
    return api.storage.files.list(["playlists"]).then(function (sectionEntries) {
      var sections = [];
      for (var i = 0; i < sectionEntries.length; i++) {
        if (sectionEntries[i].isDir) sections.push(sectionEntries[i].name);
      }
      var playlistLoads = [];
      for (var s = 0; s < sections.length; s++) {
        (function (sec) {
          playlistLoads.push(
            api.storage.files.list(["playlists", sec]).then(function (plEntries) {
              var loads = [];
              for (var j = 0; j < plEntries.length; j++) {
                if (!plEntries[j].isDir) continue;
                (function (plId) {
                  loads.push(loadPlaylistFromDisk(sec, plId));
                })(plEntries[j].name);
              }
              return Promise.all(loads);
            })
          );
        })(sections[s]);
      }
      return Promise.all(playlistLoads);
    }).then(function (perSection) {
      var allPlaylists = [];
      var allTracks = {};
      for (var i = 0; i < perSection.length; i++) {
        var loaded = perSection[i];
        for (var j = 0; j < loaded.length; j++) {
          var entry = loaded[j];
          if (!entry) continue;
          allPlaylists.push(entry.playlist);
          allTracks[entry.playlist.id] = entry.tracks;
        }
      }
      return { playlists: allPlaylists, tracks: allTracks };
    });
  }

  function loadPlaylistFromDisk(sectionName, playlistIdSegment) {
    var dir = ["playlists", sectionName, playlistIdSegment];
    return Promise.all([
      api.storage.files.readJson(dir.concat(["meta.json"])),
      api.storage.files.readJson(dir.concat(["tracks.json"])),
    ]).then(function (results) {
      var meta = results[0];
      var tracks = results[1] || [];
      if (!meta) return null;

      // Resolve cover path
      var coverP = meta.coverFile
        ? api.storage.files.getPath(dir.concat([meta.coverFile]))
        : Promise.resolve(null);

      // Resolve each track's coverFile
      var trackPathPromises = [];
      for (var i = 0; i < tracks.length; i++) {
        (function (t) {
          if (t.coverFile) {
            trackPathPromises.push(
              api.storage.files.getPath(dir.concat([t.coverFile])).then(function (p) {
                if (p) t.imageUrl = p;
              })
            );
          }
        })(tracks[i]);
      }

      return coverP.then(function (coverPath) {
        return Promise.all(trackPathPromises).then(function () {
          var versionedCover = coverPath
            ? (meta.coverVersion ? coverPath + "#v=" + meta.coverVersion : coverPath)
            : null;
          var playlist = {
            id: meta.id,
            name: meta.name,
            section: meta.section || sectionName,
            description: meta.description || "",
            imageUrl: versionedCover,
            coverVersion: meta.coverVersion || null,
            uri: "spotify://playlists/" + meta.id,
            lastCheckedAt: meta.lastCheckedAt || null,
            updatedAt: meta.updatedAt || null,
          };
          return { playlist: playlist, tracks: tracks };
        });
      });
    }).catch(function (e) {
      console.error("Failed to load playlist:", sectionName, playlistIdSegment, e);
      return null;
    });
  }

  // Delete all on-disk data for a playlist (used when a refresh no longer
  // returns it from its section).
  function deletePlaylistFiles(pl) {
    return api.storage.files.remove(playlistDir(pl)).catch(function (e) {
      console.error("Failed to delete playlist dir:", pl.id, e);
    });
  }

  function savePreferences() {
    api.storage.set("spotify_browse_preferences", {
      showBrowserOnRefresh: state.showBrowserOnRefresh,
      autoRefreshHours: state.autoRefreshHours,
      lastCheckAt: state.lastCheckAt,
      lastCheckResult: state.lastCheckResult,
    }).catch(console.error);
  }

  function recordCheckResult(playlists, errors) {
    state.lastCheckAt = new Date().toISOString();
    state.lastCheckResult = playlists + " playlists";
    if (errors > 0) state.lastCheckResult += ", " + errors + " error" + (errors > 1 ? "s" : "");
    savePreferences();
  }

  // ---- Render ----

  function render() {
    if (state.currentView === "playlist") { renderPlaylist(); return; }
    renderHome();
  }

  function getStatusText() {
    if (state.status === "waiting-login") return "Waiting for login…";
    if (state.status === "finding-section") return state.refreshSummary || "Finding section…";
    if (state.status === "scraping-playlists") return "Grabbing playlists…";
    if (state.status === "scraping-tracks") {
      var lbl = "Grabbing tracks";
      if (state.scrapeProgress.name) lbl += ": " + state.scrapeProgress.name;
      if (state.scrapeProgress.total > 0) lbl += " (" + state.scrapeProgress.current + "/" + state.scrapeProgress.total + ")";
      if (state.scrapeProgress.found) lbl += " — " + state.scrapeProgress.found + " tracks";
      return lbl + "…";
    }
    if (state.status === "error") return state.errorMessage;
    if (state.refreshSummary) return state.refreshSummary;
    return "";
  }

  function isActiveStatus() {
    return state.status === "waiting-login" || state.status === "finding-section" || state.status === "scraping-playlists" || state.status === "scraping-tracks";
  }

  function buildToolbar() {
    var buttons = [];
    var isActive = isActiveStatus();

    if (isActive) {
      buttons.push({ label: "Cancel", action: "cancel" });
    } else {
      buttons.push({ label: "Sync", action: "sync" });
    }


    var statusText = "";
    var statusVariant = "default";

    if (isActive) {
      statusText = getStatusText();
    } else if (state.status === "error") {
      statusText = state.errorMessage;
      statusVariant = "error";
    } else if (state.refreshSummary) {
      statusText = state.refreshSummary;
    } else if (state.lastCheckResult) {
      statusText = state.lastCheckResult;
    }

    // Append the last-check timestamp to the status text rather than the title.
    if (!isActive && state.lastCheckAt && statusText) {
      var d = new Date(state.lastCheckAt);
      statusText += " — " + d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    }

    return {
      type: "toolbar",
      buttons: buttons,
      status: statusText || undefined,
      statusVariant: statusVariant,
    };
  }

  function buildTabs() {
    var tabs = [];
    for (var i = 0; i < state.sections.length; i++) {
      var sec = state.sections[i];
      var secPlaylists = getPlaylistsForSection(sec);
      tabs.push({ id: "section:" + sec, label: sec, count: secPlaylists.length || undefined });
    }
    tabs.push({ id: "__add__", label: "+" });
    return tabs;
  }

  // Returns the synthetic Liked Songs playlist if it's in state.playlists.
  function getLikedPlaylist() {
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === LIKED_PLAYLIST_ID) return state.playlists[i];
    }
    return null;
  }

  function buildPlaylistCards(playlists) {
    var cards = [];
    for (var pi = 0; pi < playlists.length; pi++) {
      var sp = playlists[pi];
      var ts = state.playlistTracks[sp.id];
      var sub = ts ? ts.length + " tracks" : (sp.description || "");
      if (state.updatedPlaylistIds[sp.id]) {
        var diff = getDiff(sp.id);
        var diffParts = [];
        if (diff.added.length > 0) diffParts.push("+" + diff.added.length);
        if (diff.removed.length > 0) diffParts.push("-" + diff.removed.length);
        var diffStr = diffParts.length > 0 ? " (" + diffParts.join(", ") + ")" : "";
        sub = "• Updated" + diffStr + " — " + sub;
      }
      var cardTracks = [];
      if (ts) {
        for (var ti = 0; ti < ts.length; ti++) {
          cardTracks.push({
            title: ts[ti].name || "",
            artistName: ts[ti].artist || null,
            albumName: ts[ti].album || null,
          });
        }
      }
      var menu = [
        { id: "play-playlist", label: "Play" },
        { id: "enqueue-playlist", label: "Enqueue" },
        { id: "view-playlist", label: "View / Edit" },
      ];
      // Liked Songs has no section toolbar (it's a pinned card), so expose
      // its refresh action on the card menu.
      if (sp.id === LIKED_PLAYLIST_ID) {
        menu.push({ id: "sep-refresh", label: "", separator: true });
        menu.push({ id: "refresh-liked", label: "Refresh" });
      }
      menu.push({ id: "sep", label: "", separator: true });
      menu.push({ id: "save-playlist-ctx", label: "Save to Playlists" });

      cards.push({
        id: "playlist:" + sp.id,
        title: sp.name,
        subtitle: sub,
        imageUrl: sp.imageUrl,
        action: "view-playlist",
        targetKind: "playlist",
        tracks: cardTracks,
        contextMenuActions: menu,
      });
    }
    return cards;
  }

  function renderHome() {
    api.ui.setBadge("spotify", null);
    var ch = [];
    var isActive = isActiveStatus();

    if (state.activeTab.indexOf("section:") === 0) {
      var sectionName = state.activeTab.substring(8);
      var secPlaylists = getPlaylistsForSection(sectionName);
      if (!isActive) {
        var sectionActions = [];
        // Liked Songs is a built-in collection — don't allow removal.
        if (!isLikedSection(sectionName)) {
          sectionActions.push({ type: "button", label: "Remove Section", action: "remove-section-tab", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" }, data: { section: sectionName } });
        }
        if (state.status !== "idle") {
          sectionActions.unshift(
            { type: "button", label: "Refresh " + sectionName, action: "refresh-section", variant: "secondary", disabled: state.refreshing, style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" }, data: { section: sectionName } }
          );
        }
        if (sectionActions.length > 0) {
          ch.push({
            type: "layout", direction: "horizontal", style: { "margin-bottom": "8px", "gap": "8px" },
            children: sectionActions,
          });
        }
      }
      if (secPlaylists.length === 0 && state.status === "idle") {
        ch.push({ type: "text", content: "<p style='opacity:0.5'>No playlists found for this section. Click <b>Sync</b> to scrape.</p>" });
      } else if (secPlaylists.length > 0) {
        ch.push({ type: "card-grid", items: buildPlaylistCards(secPlaylists) });
      }
    }

    var toolbar = buildToolbar();
    toolbar.buttons.push({ label: state.showBrowserOnRefresh ? "Browser: ON" : "Browser: OFF", action: "toggle-show-browser-pref", variant: state.showBrowserOnRefresh ? "accent" : "secondary" });
    var view = [toolbar];

    // Pinned Liked Songs card (rendered above the section tabs once it exists).
    var likedPl = getLikedPlaylist();
    if (likedPl) {
      view.push({
        type: "layout", direction: "vertical", style: { "padding": "12px 16px 0" },
        children: [{ type: "card-grid", items: buildPlaylistCards([likedPl]) }],
      });
    }

    view.push({ type: "tabs", activeTab: state.activeTab, action: "switch-tab", tabs: buildTabs() });

    if (state.addingSectionViaTab) {
      ch.unshift({
        type: "layout", direction: "horizontal", style: { "gap": "8px", "margin": "0 0 8px 0", "align-items": "center" },
        children: [
          { type: "text-input", placeholder: "Section name (e.g. Your Top Mixes)", action: "section-tab-input" },
          { type: "button", label: "Add", action: "add-section-tab", variant: "accent", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
          { type: "button", label: "Cancel", action: "cancel-add-section", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
        ],
      });
    }

    view.push({ type: "layout", direction: "vertical", children: ch });

    api.ui.setViewData("spotify", {
      type: "layout", direction: "vertical", children: view
    });
  }

  function renderPlaylist() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    var query = (state.playlistSearch[pl.id] || "").trim().toLowerCase();
    var contextActions = [
      { id: "play-current", label: "Play" },
      { id: "enqueue-current", label: "Enqueue" },
      { id: "sep1", label: "", separator: true },
      { id: "save-playlist", label: "Save to Playlists" },
    ];
    var headerMeta = tracks.length + " tracks";
    var ch = [
      {
        type: "detail-header",
        title: pl.name,
        meta: headerMeta,
        imageUrl: pl.imageUrl || undefined,
        backAction: "go-home",
        playAction: tracks.length > 0 ? "play-current" : undefined,
        contextMenuActions: contextActions,
      },
    ];

    // Show a search box for any playlist with enough tracks to make scanning
    // them painful. The threshold is conservative — the box is cheap.
    if (tracks.length > 50) {
      ch.push({
        type: "search-input",
        placeholder: "Filter " + tracks.length + " tracks…",
        action: "playlist-search",
        value: state.playlistSearch[pl.id] || "",
      });
    }

    if (tracks.length > 0) {
      var diff = getDiff(pl.id);
      var addedSet = {};
      for (var ai = 0; ai < diff.added.length; ai++) {
        addedSet[diff.added[ai].name + "\0" + diff.added[ai].artist] = true;
      }

      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var t = tracks[i];
        if (query) {
          // Match against title, artist, album. Case-insensitive substring.
          var hay = ((t.name || "") + " " + (t.artist || "") + " " + (t.album || "")).toLowerCase();
          if (hay.indexOf(query) === -1) continue;
        }
        var isAdded = addedSet[t.name + "\0" + t.artist];
        var item = {
          id: "track:" + i,
          title: t.name || "Unknown",
          subtitle: (t.artist || "Unknown") + (t.album ? " — " + t.album : ""),
          imageUrl: t.imageUrl || undefined,
          duration: t.duration || "",
          action: "play-track",
        };
        if (isAdded) {
          item.style = { "border-left": "3px solid var(--success)", "padding-left": "8px" };
        }
        items.push(item);
      }
      if (query && items.length === 0) {
        ch.push({ type: "text", content: "<p style='opacity:0.5;padding:12px 0'>No tracks match \"" + escapeHtml(query) + "\"</p>" });
      } else if (query) {
        ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:6px 0 0'>" + items.length + " of " + tracks.length + " tracks</p>" });
      }
      if (items.length > 0) {
        ch.push({ type: "track-row-list", items: items });
      }

      // Show removed tracks at bottom
      if (diff.removed.length > 0) {
        ch.push({ type: "spacer" });
        ch.push({ type: "text", content: "<p style='font-size:var(--fs-xs);color:var(--text-secondary);margin:0'>Removed tracks</p>" });
        var removedItems = [];
        for (var ri = 0; ri < diff.removed.length; ri++) {
          var rt = diff.removed[ri];
          removedItems.push({
            id: "removed:" + ri,
            title: rt.name || "Unknown",
            subtitle: (rt.artist || "Unknown") + (rt.album ? " — " + rt.album : ""),
            imageUrl: rt.imageUrl || undefined,
            duration: rt.duration || "",
            style: { "text-decoration": "line-through", "opacity": "0.5" },
          });
        }
        ch.push({ type: "track-row-list", items: removedItems });
      }
    } else {
      ch.push({ type: "text", content: "<p style='opacity:0.5'>No tracks scraped</p>" });
    }
    api.ui.setViewData("spotify", { type: "layout", direction: "vertical", children: ch });
  }

  function renderSettings() {
    var ch = [];

    ch.push({
      type: "select", label: "Auto-refresh interval", action: "set-auto-refresh",
      value: "" + state.autoRefreshHours,
      options: [
        { value: "0", label: "Off" },
        { value: "6", label: "Every 6 hours" },
        { value: "12", label: "Every 12 hours" },
        { value: "24", label: "Every 24 hours" },
        { value: "48", label: "Every 2 days" },
        { value: "168", label: "Every week" },
      ],
    });

    ch.push({ type: "toggle", label: "Show browser window during refresh", checked: state.showBrowserOnRefresh, action: "toggle-show-browser-pref" });

    ch.push(buildDebugTestSection());
    ch.push(buildDiagnosticsSection());

    api.ui.setViewData("spotify-settings", {
      type: "layout", direction: "vertical", children: ch,
    });
  }

  function buildDiagnosticsSection() {
    var rep = state.lastReport;
    var children = [];

    children.push({
      type: "layout", direction: "horizontal", style: { "gap": "8px", "align-items": "center" },
      children: [
        { type: "button", label: state.showDiagnostics ? "Hide" : "Show Last Run", action: "toggle-diagnostics", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
        { type: "button", label: "Clear History", action: "clear-diagnostics", variant: "secondary", style: { "font-size": "var(--fs-xs)", "padding": "3px 10px" } },
      ],
    });

    if (!state.showDiagnostics) {
      return { type: "section", title: "Diagnostics", children: children };
    }

    if (!rep) {
      children.push({ type: "text", content: "<p>No runs recorded yet. Click Sync or refresh a section to populate diagnostics.</p>" });
      return { type: "section", title: "Diagnostics", children: children };
    }

    var started = new Date(rep.startedAt);
    var header = "<p><b>" + escapeHtml(rep.trigger || "run") + "</b> — " +
      escapeHtml(started.toLocaleString()) + "<br/>" +
      "Outcome: <b>" + escapeHtml(rep.outcome) + "</b> in " + Math.round((rep.durationMs || 0) / 1000) + "s";
    if (rep.errorMessage) header += "<br/><b>Error:</b> " + escapeHtml(rep.errorMessage);
    header += "</p>";
    children.push({ type: "text", content: header });

    if (rep.sections && rep.sections.length) {
      var secLines = "<p><b>Sections:</b></p><ul>";
      for (var si = 0; si < rep.sections.length; si++) {
        var sec = rep.sections[si];
        secLines += "<li>" + escapeHtml(sec.name) + " — <b>" + escapeHtml(sec.status) + "</b>, " +
          sec.playlistCount + " playlists, " + (sec.attempts || 0) + " attempt" + (sec.attempts === 1 ? "" : "s");
        if (sec.snapshot && sec.snapshot.url) {
          secLines += "<br/><i>" + escapeHtml(sec.snapshot.url) + "</i>";
          if (sec.snapshot.counts) secLines += "<br/>counts: " + escapeHtml(safeStringify(sec.snapshot.counts));
        }
        secLines += "</li>";
      }
      secLines += "</ul>";
      children.push({ type: "text", content: secLines });
    }

    if (rep.playlists && rep.playlists.length) {
      var failed = [];
      var okCount = 0;
      for (var pi = 0; pi < rep.playlists.length; pi++) {
        if (rep.playlists[pi].status === "ok") okCount++;
        else failed.push(rep.playlists[pi]);
      }
      var summary = "<p><b>Playlists:</b> " + okCount + " ok";
      if (failed.length) summary += ", <b>" + failed.length + " failed</b>";
      summary += " (of " + rep.playlists.length + ")</p>";
      children.push({ type: "text", content: summary });

      if (failed.length) {
        var fhtml = "<p><b>Failures:</b></p><ul>";
        for (var fi = 0; fi < failed.length; fi++) {
          var f = failed[fi];
          fhtml += "<li><b>" + escapeHtml(f.name || "?") + "</b>";
          if (f.section) fhtml += " [" + escapeHtml(f.section) + "]";
          fhtml += " — " + escapeHtml(f.status) +
            " in " + Math.round((f.durationMs || 0) / 1000) + "s";
          if (f.error) fhtml += "<br/>error: " + escapeHtml(f.error.substring(0, 200));
          if (f.snapshot && f.snapshot.url) {
            fhtml += "<br/>url: <i>" + escapeHtml(f.snapshot.url) + "</i>";
            if (f.snapshot.counts) fhtml += "<br/>counts: " + escapeHtml(safeStringify(f.snapshot.counts));
          }
          fhtml += "</li>";
        }
        fhtml += "</ul>";
        children.push({ type: "text", content: fhtml });
      }
    }

    children.push({ type: "text", content: "<p><i>Detailed logs are written to the app log file (filter by spotify-browse). The full last-sync trace is stored in plugin storage as <code>last_sync.log</code>.</i></p>" });

    return { type: "section", title: "Diagnostics", children: children };
  }

  // ---- Interactive step-by-step debugger ----

  var dbgTest = {
    status: "idle", // idle | running | waiting | done
    sectionName: "Made for You",
    currentStep: 0,
    steps: [],
    handle: null,
    playlists: [],
    selectedPlaylist: "",
  };

  var DBG_STEPS = [
    { id: "login", label: "1. Check Login" },
    { id: "find-section", label: "2. Find Section" },
    { id: "scrape-playlists", label: "3. Scrape Playlists" },
    { id: "scrape-tracks", label: "4. Scrape Tracks" },
  ];

  function dbgStart() {
    dbgTest.status = "waiting";
    dbgTest.currentStep = 0;
    dbgTest.steps = [];
    dbgTest.playlists = [];
    dbgTest.selectedPlaylist = "";
    dbgOpenLiveWindow().then(function () {
      renderSettings();
    }).catch(function (e) {
      api.log("error", "Failed to open debug window: " + e);
      renderSettings();
    });
    renderSettings();
  }

  function dbgRunStep(stepId) {
    if (stepId === "login") {
      dbgTest.steps.push({ id: "login", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      dbgOpenLiveWindow().then(function () {
        dbgCheckLogin();
      }).catch(function (e) {
        dbgStepFail("login", "Failed to open window: " + e);
      });
    } else if (stepId === "find-section") {
      dbgTest.steps.push({ id: "find-section", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      dbgEvalAndWait(scriptFindSection(dbgTest.sectionName), "section-found", 15000, function (data) {
        setTimeout(function () {
          dbgStepDone("find-section", "Section found: " + escapeHtml(safeStringify(data)));
        }, 4000);
      }, function () {
        dbgStepFail("find-section", "Section '" + escapeHtml(dbgTest.sectionName) + "' not found");
      });
    } else if (stepId === "scrape-playlists") {
      dbgTest.steps.push({ id: "scrape-playlists", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      setTimeout(function () {
        dbgEvalAndWait(SCRIPT_SCRAPE_PLAYLISTS, "playlists", 15000, function (data) {
          var pls = Array.isArray(data) ? data : [];
          dbgTest.playlists = pls;
          if (pls.length > 0) dbgTest.selectedPlaylist = pls[0].id;
          var names = pls.map(function (p) { return p.name; }).slice(0, 10);
          dbgStepDone("scrape-playlists", "Found <b>" + pls.length + "</b> playlist(s): " + names.map(escapeHtml).join(", ") + (pls.length > 10 ? "..." : ""));
        }, function () {
          dbgStepFail("scrape-playlists", "No playlists found (timeout)");
        });
      }, 4000);
    } else if (stepId === "scrape-tracks") {
      dbgTest.steps.push({ id: "scrape-tracks", status: "running", source: "live", log: [] });
      dbgTest.status = "running";
      renderSettings();
      var plId = dbgTest.selectedPlaylist;
      if (!plId) {
        dbgStepFail("scrape-tracks", "No playlist selected");
        return;
      }
      dbgTest.handle.eval(scriptNavigatePlaylist(plId)).catch(console.error);
      setTimeout(function () {
        dbgTest.handle.eval(scriptScrollThenScrape(plId, 999)).catch(console.error);
        dbgWaitForMessage("tracks", 30000, function (data) {
          if (data && data.tracks) {
            dbgStepDone("scrape-tracks", "Found <b>" + data.tracks.length + "</b> track(s)" + (data.error ? " (with error: " + escapeHtml(data.error) + ")" : ""));
          } else {
            dbgStepFail("scrape-tracks", "No tracks data received");
          }
        }, function () {
          dbgStepFail("scrape-tracks", "Track scrape timeout");
        });
      }, 5000);
    }
  }

  function dbgOpenLiveWindow() {
    if (dbgTest.handle) return Promise.resolve();
    return api.network.openBrowseWindow("https://open.spotify.com", {
      title: "Spotify Debug",
      width: 1200,
      height: 800,
      visible: true,
    }).then(function (h) {
      dbgTest.handle = h;
      h.onMessage(function (msg) {
        if (msg.type === "dbg" && msg.data) {
          var step = dbgTest.steps[dbgTest.steps.length - 1];
          if (step) step.log.push("[" + (msg.data.tag || "?") + "] " + (msg.data.msg || ""));
        }
        if (dbgTest._msgHandler) dbgTest._msgHandler(msg);
      });
    });
  }

  function dbgFormatLoginResult(data) {
    var details = "";
    if (data && data.signals) {
      var pos = [];
      var neg = [];
      var sigs = data.signals;
      if (sigs.sessionTag) pos.push("sessionTag");
      if (sigs.userWidget) pos.push("userWidget");
      if (sigs.userBox) pos.push("userBox");
      if (sigs.avatar) pos.push("avatar");
      if (sigs.accountLink) pos.push("accountLink");
      if (sigs.libraryBtn) pos.push("libraryBtn");
      if (sigs.createPlaylist) pos.push("createPlaylist");
      if (sigs.globalNav) pos.push("globalNav");
      if (sigs.leftSidebar) pos.push("leftSidebar");
      if (sigs.nowPlayingBar) pos.push("nowPlayingBar");
      if (sigs.mainNav) pos.push("mainNav");
      if (sigs.loginBtn) neg.push("loginBtn");
      if (sigs.signupBtn) neg.push("signupBtn");
      if (sigs.signupBar) neg.push("signupBar");
      if (sigs.loginLink) neg.push("loginLink");
      details = "<br/>Positive signals: <b>" + (pos.length > 0 ? pos.join(", ") : "none") + "</b>";
      details += "<br/>Negative signals: <b>" + (neg.length > 0 ? neg.join(", ") : "none") + "</b>";
      if (data.url) details += "<br/>URL: " + escapeHtml(data.url);
    }
    if (data && data.pageDump) {
      details += "<br/>Page dump: " + escapeHtml(safeStringify(data.pageDump)).substring(0, 300);
    }
    return details;
  }

  function dbgCheckLogin() {
    var retries = 0;
    var maxRetries = 15;
    var lastData = null;
    var pollTimer = null;

    function finish(success, message) {
      if (success) dbgStepDone("login", message);
      else dbgStepFail("login", message);
    }

    function attempt() {
      retries++;
      dbgTest._msgHandler = function (msg) {
        if (msg.type === "login-check" && msg.data) {
          lastData = msg.data;
          dbgTest._msgHandler = null;
          var hasPositive = lastData.signals && (lastData.signals.sessionTag || lastData.signals.userWidget || lastData.signals.userBox || lastData.signals.avatar || lastData.signals.accountLink || lastData.signals.libraryBtn || lastData.signals.createPlaylist || lastData.signals.globalNav || lastData.signals.leftSidebar || lastData.signals.nowPlayingBar || lastData.signals.mainNav);
          var hasNegative = lastData.signals && (lastData.signals.loginBtn || lastData.signals.signupBtn || lastData.signals.signupBar || lastData.signals.loginLink);

          if (lastData.loggedIn) {
            if (pollTimer) clearInterval(pollTimer);
            var details = dbgFormatLoginResult(lastData);
            finish(true, "Logged in (attempt " + retries + "/" + maxRetries + ")" + details);
          } else if (hasNegative) {
            if (pollTimer) clearInterval(pollTimer);
            var details = dbgFormatLoginResult(lastData);
            finish(false, "Not logged in (attempt " + retries + "/" + maxRetries + ")" + details);
          } else if (retries >= maxRetries) {
            if (pollTimer) clearInterval(pollTimer);
            var details = dbgFormatLoginResult(lastData);
            finish(false, "No clear signal after " + maxRetries + " attempts" + details);
          }
          // else: no clear signal yet, keep polling
        }
      };
      dbgTest.handle.eval(SCRIPT_CHECK_LOGIN).catch(function () {
        if (retries >= maxRetries) {
          if (pollTimer) clearInterval(pollTimer);
          finish(false, "Script evaluation failed");
        }
      });
    }

    // Wait 2s for initial page load, then poll every 3s
    setTimeout(function () {
      attempt();
      pollTimer = setInterval(attempt, 3000);
    }, 2000);
  }

  function dbgEvalAndWait(script, msgType, timeout, onSuccess, onTimeout) {
    dbgWaitForMessage(msgType, timeout, onSuccess, onTimeout);
    dbgTest.handle.eval(script).catch(function (e) {
      onTimeout();
    });
  }

  function dbgWaitForMessage(msgType, timeout, onSuccess, onTimeout) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      dbgTest._msgHandler = null;
      onTimeout();
    }, timeout);

    dbgTest._msgHandler = function (msg) {
      if (msg.type === msgType) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        dbgTest._msgHandler = null;
        onSuccess(msg.data);
      }
    };
  }

  function dbgStepDone(stepId, message) {
    var step = dbgTest.steps.find(function (s) { return s.id === stepId; });
    if (step) { step.status = "done"; step.result = message; }
    dbgTest.status = "waiting";
    dbgTest.currentStep++;
    renderSettings();
  }

  function dbgStepFail(stepId, message) {
    var step = dbgTest.steps.find(function (s) { return s.id === stepId; });
    if (step) { step.status = "failed"; step.result = message; }
    dbgTest.status = "waiting";
    dbgTest.currentStep++;
    renderSettings();
  }

  function dbgStop() {
    if (dbgTest.handle) {
      dbgTest.handle.close().catch(console.error);
      dbgTest.handle = null;
    }
    dbgTest._msgHandler = null;
    dbgTest.status = "idle";
    dbgTest.steps = [];
    dbgTest.playlists = [];
    renderSettings();
  }

  function buildDebugTestSection() {
    var children = [];
    var running = dbgTest.status === "running";
    var waiting = dbgTest.status === "waiting";
    var idle = dbgTest.status === "idle";

    // Section name input + Start/Stop
    var headerButtons = [];
    if (running) {
      headerButtons.push({ type: "button", label: "Stop", action: "dbg-stop", variant: "secondary", style: { padding: "3px 14px" } });
    } else if (idle) {
      headerButtons.push({ type: "button", label: "Start", action: "dbg-start", variant: "accent", style: { padding: "3px 14px" } });
    } else {
      headerButtons.push({ type: "button", label: "Reset", action: "dbg-stop", variant: "secondary", style: { padding: "3px 10px" } });
    }
    if (dbgTest.handle) {
      headerButtons.push({ type: "button", label: "DevTools", action: "dbg-devtools", variant: "secondary", style: { padding: "3px 10px" } });
    }

    children.push({
      type: "layout", direction: "horizontal", style: { gap: "8px", "align-items": "center" },
      children: [
        { type: "text-input", placeholder: "Section name (e.g. Made for You)", action: "dbg-section-name", value: dbgTest.sectionName, style: { flex: "1" }, disabled: running || waiting },
      ].concat(headerButtons),
    });

    // Step results
    for (var i = 0; i < dbgTest.steps.length; i++) {
      var step = dbgTest.steps[i];
      var icon = step.status === "done" ? "✓" : step.status === "failed" ? "✗" : "⋯";
      var color = step.status === "done" ? "var(--success)" : step.status === "failed" ? "var(--error)" : "var(--text-secondary)";
      var stepLabel = DBG_STEPS.find(function (s) { return s.id === step.id; });
      var content = "<div style=\"font-size:var(--fs-xs);padding:4px 0;border-bottom:1px solid var(--border)\">" +
        "<span style=\"color:" + color + ";font-weight:bold\">" + icon + "</span> " +
        "<b>" + (stepLabel ? stepLabel.label : step.id) + "</b>" +
        " <span style=\"opacity:0.6\">(" + step.source + ")</span>" +
        (step.result ? "<br/>" + step.result : "") +
        "</div>";
      children.push({ type: "text", content: content });

      // Show logs if step failed
      if (step.status === "failed" && step.log && step.log.length > 0) {
        var logHtml = step.log.slice(-10).map(function (l) {
          return "<p style=\"margin:1px 0;font-size:var(--fs-2xs);opacity:0.7\">" + escapeHtml(l) + "</p>";
        }).join("");
        children.push({ type: "text", content: "<div style=\"padding-left:16px\">" + logHtml + "</div>" });
      }
    }

    // Next step source choice (when waiting and steps remain)
    if (waiting && dbgTest.currentStep < DBG_STEPS.length) {
      var nextStep = DBG_STEPS[dbgTest.currentStep];
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);margin-top:8px\"><b>Next:</b> " + nextStep.label + "</p>" });

      // Playlist selector for track scraping step
      if (nextStep.id === "scrape-tracks" && dbgTest.playlists.length > 0) {
        children.push({
          type: "select", label: "Playlist to scrape", action: "dbg-select-playlist",
          value: dbgTest.selectedPlaylist,
          options: dbgTest.playlists.map(function (p) { return { value: p.id, label: p.name || p.id }; }),
        });
      }

      children.push({
        type: "button", label: "Run Step", action: "dbg-next-step", variant: "accent", style: { padding: "3px 14px", "margin-top": "4px" },
      });
    }

    // All done
    if (waiting && dbgTest.currentStep >= DBG_STEPS.length) {
      children.push({ type: "text", content: "<p style=\"font-size:var(--fs-xs);margin-top:8px;color:var(--success)\"><b>All steps completed.</b></p>" });
    }

    return { type: "section", title: "Step-by-Step Debugger", children: children };
  }

  // ---- Injected scripts (plain strings for eval) ----

  var DBG_HELPER =
    'function _dbg(tag,msg,data){' +
      'console.log("[spotify-dbg]",tag,msg,data);' +
      'try{if(window.__viboplr&&window.__viboplr.send)window.__viboplr.send("dbg",{tag:tag,msg:msg,data:data,level:"info"})}catch(e){}' +
    '}' +
    'function _dbgErr(tag,msg,data){' +
      'console.error("[spotify-dbg]",tag,msg,data);' +
      'try{if(window.__viboplr&&window.__viboplr.send)window.__viboplr.send("dbg",{tag:tag,msg:msg,data:data,level:"error"})}catch(e){}' +
    '}';

  // Capture a compact DOM snapshot for failure diagnostics. Sent via __viboplr.send("snapshot", {...}).
  var SNAPSHOT_HELPER =
    'function _snap(label){' +
      'try{' +
        'var body=document.body?document.body.innerHTML:"";' +
        'if(body.length>8192)body=body.substring(0,8192)+"...[truncated "+(body.length-8192)+" chars]";' +
        'var testids=[];var tidNodes=document.querySelectorAll("[data-testid]");' +
        'for(var t=0;t<Math.min(tidNodes.length,50);t++)testids.push(tidNodes[t].getAttribute("data-testid"));' +
        'var counts={' +
          'playlistLinks:document.querySelectorAll("a[href*=\\"/playlist/\\"]").length,' +
          'draggableLinks:document.querySelectorAll("a[draggable=\\"false\\"][href*=\\"/playlist/\\"]").length,' +
          'rows:document.querySelectorAll("[role=\\"row\\"]").length,' +
          'trackLinks:document.querySelectorAll("a[href*=\\"/track/\\"]").length,' +
          'artistLinks:document.querySelectorAll("a[href*=\\"/artist/\\"]").length,' +
          'mainEl:!!document.querySelector("main"),' +
          'trackList:!!document.querySelector("[data-testid=\\"playlist-tracklist\\"]")' +
        '};' +
        'window.__viboplr.send("snapshot",{label:label,url:location.href,title:document.title,counts:counts,testids:testids,bodyExcerpt:body});' +
      '}catch(e){window.__viboplr.send("snapshot",{label:label,error:""+e})}' +
    '}';

  // Click a filter pill / nav item labeled "Music". Spotify shows these above the
  // library when filtered to shows/podcasts — switching back to Music reveals playlists.
  var SCRIPT_CLICK_MUSIC = '(function(){try{' +
    DBG_HELPER +
    'var candidates=document.querySelectorAll(\'button,a,[role="button"],[role="tab"],[role="listitem"] span\');' +
    '_dbg("music","scanning "+candidates.length+" candidates");' +
    'for(var i=0;i<candidates.length;i++){' +
      'var el=candidates[i];' +
      'var txt=(el.textContent||"").trim();' +
      'if(txt.toLowerCase()==="music"){' +
        'var clickEl=el.tagName==="SPAN"?(el.closest("button")||el.closest("a")||el.closest(\'[role="button"]\')||el.closest(\'[role="tab"]\')||el.closest(\'[role="listitem"]\')||el):el;' +
        '_dbg("music","FOUND \'Music\', clicking",{tag:clickEl.tagName,role:clickEl.getAttribute("role")});' +
        'clickEl.click();' +
        'window.__viboplr.send("music-clicked",{ok:true});' +
        'return;' +
      '}' +
    '}' +
    '_dbg("music","NOT FOUND");' +
    'window.__viboplr.send("music-clicked",{ok:false});' +
    '}catch(e){window.__viboplr.send("music-clicked",{ok:false,error:""+e})}})()';

  var IMG_HELPER =
    'function isValidImgUrl(u){' +
      'if(!u||u.length<20)return false;' +
      'if(u.indexOf("data:")===0||u.indexOf("blob:")===0)return false;' +
      'if(u.indexOf("pickasso.spotifycdn.com")!==-1&&u.split("/").length<10)return false;' +
      'return true;' +
    '}' +
    'function bestImg(el){' +
      'var imgs=el.querySelectorAll("img");' +
      'for(var k=0;k<imgs.length;k++){' +
        'var s=imgs[k].currentSrc||imgs[k].src||"";' +
        'if(isValidImgUrl(s))return s;' +
        'var ss=imgs[k].getAttribute("srcset");' +
        'if(ss){var parts=ss.split(",");for(var p=parts.length-1;p>=0;p--){' +
          'var u=parts[p].trim().split(/\\s+/)[0];if(isValidImgUrl(u))return u;' +
        '}}' +
        'var ds=imgs[k].getAttribute("data-src");' +
        'if(isValidImgUrl(ds))return ds;' +
      '}' +
      'var bgs=el.querySelectorAll("[style]");' +
      'for(var b=0;b<bgs.length;b++){' +
        'var bg=bgs[b].style.backgroundImage||"";' +
        'var bm=bg.match(/url\\([\\"\\\']*([^\\"\\\'\\)]+)/);' +
        'if(bm&&isValidImgUrl(bm[1]))return bm[1];' +
      '}' +
      'return null;' +
    '}';

  var SCRIPT_CHECK_LOGIN = '(function(){' +
    'console.log("[viboplr-login] script start");' +
    'try{' +
    'function qs(sel){try{return document.querySelector(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return null}}' +
    'function qsa(sel){try{return document.querySelectorAll(sel)}catch(e){console.log("[viboplr-login] bad selector: "+sel+" err: "+e);return[]}}' +
    'var signals={};' +
    'var sessionEl=qs("script#session,script[data-testid=\\"session\\"]");' +
    'signals.sessionTag=false;' +
    'if(sessionEl){try{var sj=JSON.parse(sessionEl.textContent||"{}");signals.sessionTag=!!sj.accessToken}catch(e){}}' +
    'signals.userWidget=!!qs("[data-testid=\\"user-widget-link\\"]");' +
    'signals.userBox=!!qs(".main-userWidget-box");' +
    'signals.avatar=!!qs("img[alt*=\\"avatar\\"], img[alt*=\\"profile\\"]");' +
    'signals.accountLink=!!qs("a[href*=\\"/account\\"], button[data-testid=\\"user-widget-link\\"]");' +
    'signals.libraryBtn=!!qs("[data-testid=\\"your-library-button\\"], [aria-label=\\"Your Library\\"], [aria-label*=\\"library\\"]");' +
    'signals.createPlaylist=!!qs("[aria-label*=\\"Create\\"]");' +
    'signals.globalNav=!!qs("[data-testid=\\"global-nav-bar\\"], #global-nav-bar");' +
    'signals.leftSidebar=!!qs("[data-testid=\\"Desktop_LeftSidebar_Id\\"]");' +
    'signals.nowPlayingBar=!!qs("[data-testid=\\"now-playing-bar\\"], .Root__now-playing-bar");' +
    'signals.mainNav=!!qs("nav[aria-label=\\"Main\\"]");' +
    'signals.loginBtn=!!qs("[data-testid=\\"login-button\\"]");' +
    'signals.signupBtn=!!qs("[data-testid=\\"signup-button\\"], a[href*=\\"signup\\"]");' +
    'signals.signupBar=!!qs("[data-testid=\\"signup-bar\\"]");' +
    'signals.loginLink=!!qs("a[href*=\\"/login\\"]");' +
    'console.log("[viboplr-login] signals:",JSON.stringify(signals));' +
    'var pos=signals.sessionTag||signals.userWidget||signals.userBox||signals.avatar||signals.accountLink||signals.libraryBtn||signals.createPlaylist||signals.globalNav||signals.leftSidebar||signals.nowPlayingBar||signals.mainNav;' +
    'var neg=signals.loginBtn||signals.signupBtn||signals.signupBar||signals.loginLink;' +
    'var ok=pos&&!neg;' +
    'var pageDump=null;' +
    'if(!pos&&!neg){' +
      'var btns=qsa("button");' +
      'var btnTexts=[];for(var b=0;b<Math.min(btns.length,20);b++){btnTexts.push((btns[b].textContent||"").trim().substring(0,40)+"["+(btns[b].getAttribute("data-testid")||btns[b].getAttribute("aria-label")||"")+"]")}' +
      'var navs=qsa("nav a, nav button");' +
      'var navTexts=[];for(var n=0;n<Math.min(navs.length,20);n++){navTexts.push((navs[n].textContent||"").trim().substring(0,40))}' +
      'var testids=qsa("[data-testid]");' +
      'var tidList=[];for(var t=0;t<Math.min(testids.length,40);t++){tidList.push(testids[t].getAttribute("data-testid"))}' +
      'pageDump={buttons:btnTexts,navItems:navTexts,testids:tidList,bodyClasses:document.body.className,title:document.title};' +
      'console.log("[viboplr-login] NO CLEAR SIGNAL page dump:",JSON.stringify(pageDump));' +
    '}' +
    'console.log("[viboplr-login] result: loggedIn="+ok+" pos="+pos+" neg="+neg);' +
    'window.__viboplr.send("login-check",{loggedIn:ok,signals:signals,url:location.href,pageDump:pageDump});' +
    '}catch(e){' +
      'console.error("[viboplr-login] CAUGHT ERROR:",e,""+e,e.stack);' +
      'try{window.__viboplr.send("login-check",{loggedIn:false,error:""+e})}catch(e2){console.error("[viboplr-login] send also failed:",e2)}' +
    '}})()';

  // Parameterized section finder — replaces hardcoded SCRIPT_FIND_MADE_FOR_YOU
  function scriptFindSection(sectionName) {
    var lower = sectionName.toLowerCase().replace(/'/g, "\\'");
    return '(function(){try{' +
      DBG_HELPER +
      'var target="' + lower + '";' +
      'var links=document.querySelectorAll("a");' +
      'var linkTexts=[];for(var x=0;x<Math.min(links.length,30);x++){linkTexts.push(links[x].textContent.trim().substring(0,60))}' +
      '_dbg("section","searching "+links.length+" links for \\""+target+"\\"",linkTexts);' +
      'for(var i=0;i<links.length;i++){' +
        'var txt=(links[i].textContent||"").trim().toLowerCase();' +
        'if(txt===target||txt.indexOf(target)!==-1){' +
          'var href=links[i].getAttribute("href")||"";' +
          '_dbg("section","FOUND via link",{index:i,text:txt,href:href});' +
          'links[i].click();' +
          'window.__viboplr.send("section-found",{href:href});' +
          'return;' +
        '}' +
      '}' +
      'var headings=document.querySelectorAll("h2, h3, span, p");' +
      '_dbg("section","checking "+headings.length+" headings/spans");' +
      'for(var j=0;j<headings.length;j++){' +
        'var h=headings[j];' +
        'var ht=(h.textContent||"").trim().toLowerCase();' +
        'if(ht===target||ht.indexOf(target)!==-1){' +
          'var parent=h.closest("a");' +
          'if(parent){' +
            '_dbg("section","FOUND via heading>a",{tag:h.tagName,text:ht,href:parent.getAttribute("href")});' +
            'parent.click();' +
            'window.__viboplr.send("section-found",{href:parent.getAttribute("href")||""});' +
            'return;' +
          '}' +
          '_dbg("section","FOUND via heading click",{tag:h.tagName,text:ht});' +
          'h.click();' +
          'window.__viboplr.send("section-found",{href:"clicked-heading"});' +
          'return;' +
        '}' +
      '}' +
      '_dbg("section","NOT FOUND: \\""+target+"\\"",{url:location.href});' +
      'window.__viboplr.send("section-not-found",{});' +
      '}catch(e){window.__viboplr.send("error",{message:"find section: "+e})}})()';
  }

  var SCRIPT_SCRAPE_PLAYLISTS = '(function(){try{' +
    DBG_HELPER +
    IMG_HELPER +
    'var out=[];var seen={};' +
    '_dbg("playlists","starting scrape",{url:location.href});' +
    'function findImgContainer(el){' +
      'var node=el;' +
      'for(var up=0;up<6&&node;up++){' +
        'var img=bestImg(node);' +
        'if(img)return img;' +
        'node=node.parentElement;' +
      '}' +
      'return null;' +
    '}' +
    'var allLinks=document.querySelectorAll("a[class][draggable=\\"false\\"][href*=\\"/playlist/\\"]");' +
    '_dbg("playlists","draggable=false playlist links",{count:allLinks.length});' +
    'for(var i=0;i<allLinks.length;i++){' +
      'var la=allLinks[i];' +
      'var lm=(la.getAttribute("href")||"").match(/\\/playlist\\/([a-zA-Z0-9]+)/);' +
      'if(!lm||seen[lm[1]])continue;seen[lm[1]]=1;' +
      'var lnm=la.textContent.trim();' +
      'var limg=findImgContainer(la);' +
      '_dbg("playlists","link["+i+"] found",{id:lm[1],name:lnm,href:la.getAttribute("href"),hasImg:!!limg});' +
      'if(lnm)out.push({id:lm[1],name:lnm,description:"",imageUrl:limg,uri:"spotify://playlists/"+lm[1]});' +
    '}' +
    '_dbg("playlists","DONE",{total:out.length,names:out.map(function(p){return p.name})});' +
    'window.__viboplr.send("playlists",out);' +
    '}catch(e){window.__viboplr.send("error",{message:""+e})}})()';

  function scriptNavigatePlaylist(id) {
    if (id === LIKED_PLAYLIST_ID) {
      return '(function(){' +
        DBG_HELPER +
        '_dbg("tracks","navigating to /collection/tracks");' +
        'window.location.href="/collection/tracks"' +
      '})()';
    }
    return '(function(){' +
      DBG_HELPER +
      '_dbg("tracks","navigating to /playlist/' + id + '");' +
      'window.location.href="/playlist/' + id + '"' +
    '})()';
  }

  function scriptScrollThenScrape(playlistId, gen, opts) {
    var maxSteps = (opts && opts.maxSteps) || 60;
    return '(function(){try{' +
      DBG_HELPER +
      IMG_HELPER +
      'var _gen=' + gen + ';' +
      '_dbg("tracks","=== START scrape for ' + playlistId + '",{url:location.href,gen:_gen});' +
      // Find the scroll container, retrying if the page hasn't rendered yet
      'var sc=null;var _waitAttempts=0;var _maxWait=16;' +
      'function findScrollContainer(){' +
        'var mainEl=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")' +
          '||document.querySelector("main")||document;' +
        'var found=document.scrollingElement;' +
        'var walker=mainEl;' +
        'while(walker&&walker!==document.body){' +
          'var cs=window.getComputedStyle(walker);' +
          'var ov=cs.overflowY;' +
          'if((ov==="auto"||ov==="scroll")&&walker.scrollHeight>walker.clientHeight){found=walker;break}' +
          'walker=walker.parentElement;' +
        '}' +
        'return found;' +
      '}' +
      'function waitForContent(){' +
        '_waitAttempts++;' +
        'sc=findScrollContainer();' +
        'var hasRows=!!document.querySelector("[role=\\"row\\"]");' +
        'var contentReady=(sc.tagName!=="HTML"&&sc.scrollHeight>sc.clientHeight)||hasRows;' +
        'if(!contentReady&&_waitAttempts<_maxWait){' +
          'setTimeout(waitForContent,500);return;' +
        '}' +
        'if(!contentReady){' +
          '_dbg("tracks","content not ready after wait, proceeding with fallback",{attempts:_waitAttempts,tag:sc.tagName,hasRows:hasRows,url:location.href,hasLogin:!!document.querySelector("[data-testid=\\"login-button\\"]")});' +
        '}' +
        '_dbg("tracks","scroll container",{tag:sc.tagName,testid:sc.getAttribute&&sc.getAttribute("data-testid"),scrollH:sc.scrollHeight,clientH:sc.clientHeight,overflow:window.getComputedStyle(sc).overflowY,waitAttempts:_waitAttempts});' +
        'beginScrape();' +
      '}' +
      'function beginScrape(){' +
      // Extract playlist cover. Prefer og:image (server-rendered, canonical for the URL)
      // because in-page <img> selectors can drift to track-row art for algorithmic
      // playlists like Discover Weekly / Release Radar.
      'var _coverUrl=null;var _coverRule=null;var _coverElement=null;' +
      'var _coverRuleAttempts=[];' +
      'function _markRule(rule,ok,detail){_coverRuleAttempts.push({rule:rule,ok:!!ok,detail:detail||null})}' +
      'var ogEl=document.querySelector("meta[property=\\"og:image\\"]");' +
      'if(ogEl){var ogVal=ogEl.getAttribute("content")||"";if(isValidImgUrl(ogVal)){_coverUrl=ogVal;_coverRule="og:image";_coverElement="meta[property=og:image]";_markRule("og:image",true,ogVal.substring(0,120))}else{_markRule("og:image",false,"invalid url: "+ogVal.substring(0,80))}}else{_markRule("og:image",false,"meta tag missing")}' +
      'if(!_coverUrl){' +
        'var coverElSel=null;var coverEl=null;' +
        'var sels=["[data-testid=\\"playlist-image\\"]","[data-testid=\\"entity-image\\"] img","main header img[draggable=\\"false\\"]","main picture img"];' +
        'for(var ci=0;ci<sels.length;ci++){var ce=document.querySelector(sels[ci]);if(ce){coverEl=ce;coverElSel=sels[ci];break}}' +
        'if(coverEl){var cu=coverEl.currentSrc||coverEl.src||null;if(cu&&cu.indexOf("data:")===0)cu=null;if(cu){_coverUrl=cu;_coverRule="dom-selector";_coverElement=coverElSel;_markRule("dom-selector",true,coverElSel)}else{_markRule("dom-selector",false,"matched "+coverElSel+" but no usable src")}}else{_markRule("dom-selector",false,"no selector matched")}' +
      '}' +
      // Last-resort scope: header only. Never `main section` — that wrapper contains
      // the tracklist, so bestImg() returns the first track row's album art.
      'if(!_coverUrl){' +
        'var headerEl=document.querySelector("[data-testid=\\"playlist-page\\"] header")||document.querySelector("main header");' +
        'if(headerEl){var hu=bestImg(headerEl);if(hu){_coverUrl=hu;_coverRule="header-bestImg";_coverElement="header";_markRule("header-bestImg",true,"header found")}else{_markRule("header-bestImg",false,"header had no usable img")}}else{_markRule("header-bestImg",false,"no header element")}' +
      '}' +
      'if(!_coverUrl){_dbg("tracks","cover NOT FOUND",_coverRuleAttempts)}' +
      // Incremental scroll: move one viewport at a time, scrape visible rows at each stop
      'var allOut=[];var seenKeys={};var n=0;var maxSteps=' + maxSteps + ';' +
      'var step=Math.max(sc.clientHeight-50,200);' +
      'sc.scrollTop=0;' +
      'function parseVisibleRows(){' +
        'var scope=document.querySelector("[data-testid=\\"playlist-tracklist\\"]")||document.querySelector("main")||document;' +
        'var rows=scope.querySelectorAll("[role=\\"row\\"]");' +
        'var added=0;' +
        'for(var i=0;i<rows.length;i++){var r=rows[i];' +
          'var ne=r.querySelector("[data-testid=\\"internal-track-link\\"] div")' +
            '||r.querySelector("a[href*=\\"/track/\\"]")' +
            '||r.querySelector("[data-testid=\\"tracklist-row\\"] a");' +
          'if(!ne){var cells=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells.length>=2){ne=cells[1].querySelector("a")||cells[1].querySelector("div>div>span")||cells[1].querySelector("span")}}' +
          'var nm=ne?ne.textContent.trim():"";' +
          'if(!nm)continue;' +
          'var trkLink=r.querySelector("a[href*=\\"/track/\\"]");' +
          'var spId=trkLink?trkLink.getAttribute("href").split("/track/")[1].split("?")[0]:null;' +
          'var key=spId||nm;' +
          'if(seenKeys[key])continue;seenKeys[key]=1;' +
          'var aLinks=r.querySelectorAll("a[href*=\\"/artist/\\"]");' +
          'var arts=[];for(var j=0;j<aLinks.length;j++){var at=aLinks[j].textContent.trim();if(at&&arts.indexOf(at)===-1)arts.push(at)}' +
          'if(!arts.length){var cells2=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells2.length>=2){var spans=cells2[1].querySelectorAll("span");' +
              'for(var s=0;s<spans.length;s++){var st=spans[s].textContent.trim();' +
                'if(st&&st!==nm&&st.indexOf(nm)===-1&&nm.indexOf(st)===-1){arts.push(st);break}}}}' +
          'var alEl=r.querySelector("a[href*=\\"/album/\\"]");' +
          'var al=alEl?alEl.textContent.trim():"";' +
          'var du=r.querySelector("[data-testid=\\"tracklist-duration\\"]");' +
          'if(!du){var cells3=r.querySelectorAll("[role=\\"gridcell\\"]");' +
            'if(cells3.length>0){du=cells3[cells3.length-1]}}' +
          'var dur="";if(du){var dt=du.textContent.trim();if(/^\\d+:\\d{2}$/.test(dt))dur=dt}' +
          'var imgUrl=bestImg(r);' +
          'allOut.push({name:nm,artist:arts.join(", "),album:al,duration:dur,imageUrl:imgUrl,spotifyId:spId});' +
          'added++;' +
        '}' +
        'return added;' +
      '}' +
      'function tick(){try{' +
        'parseVisibleRows();n++;' +
        'var atBottom=sc.scrollTop+sc.clientHeight>=sc.scrollHeight-10;' +
        'if(n%5===0)_dbg("tracks","scrolling",{tick:n,found:allOut.length,scrollTop:sc.scrollTop,scrollH:sc.scrollHeight,atBottom:atBottom});' +
        // Emit a running track count so the UI can show progress without waiting
        // for the full scrape (large playlists like Liked Songs can take minutes).
        'try{window.__viboplr.send("tracks-progress",{playlistId:"' + playlistId + '",found:allOut.length,gen:_gen})}catch(e){}' +
        'if(atBottom||n>=maxSteps){' +
          'parseVisibleRows();' +
          'var descEl=document.querySelector("[data-testid=\\"playlist-description\\"]")||document.querySelector("main [data-testid=\\"entityTitle\\"] ~ span");' +
          'var desc=descEl?descEl.textContent.trim():"";' +
          'if(allOut.length===0){' +
            'var diag={rows:document.querySelectorAll("[role=\\"row\\"]").length,' +
              'trackLinks:document.querySelectorAll("a[href*=\\"/track/\\"]").length,' +
              'tracklist:!!document.querySelector("[data-testid=\\"playlist-tracklist\\"]"),' +
              'url:location.href,title:document.title,' +
              'mainText:(document.querySelector("main")?document.querySelector("main").textContent:"").substring(0,200)};' +
            '_dbg("tracks","=== EMPTY ' + playlistId + ' - page diagnostics",diag);' +
          '}' +
          '_dbg("tracks","=== DONE ' + playlistId + '",{parsed:allOut.length,steps:n,gen:_gen,desc:desc.substring(0,80),coverUrl:_coverUrl,coverRule:_coverRule,coverElement:_coverElement});' +
          'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:allOut,description:desc,coverUrl:_coverUrl,coverRule:_coverRule,coverElement:_coverElement,coverRuleAttempts:_coverRuleAttempts,gen:_gen});' +
        '}else{sc.scrollTop+=step;setTimeout(tick,600)}' +
      '}catch(e){' +
        '_dbg("tracks","=== ERROR in tick ' + playlistId + '",{error:""+e,step:n});' +
        'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:allOut,error:""+e,gen:_gen});' +
      '}}' +
      'setTimeout(tick,500);' +
      '}' +
      'waitForContent();' +
    '}catch(e){' +
      'window.__viboplr.send("tracks",{playlistId:"' + playlistId + '",tracks:[],error:"script error: "+e,gen:' + gen + '});' +
    '}})()';
  }

  // ---- Consolidated scrape function ----

  function performScrape(showProgress, visible, sectionsOverride, trigger) {
    // Full syncs always include Liked Songs alongside whatever sections the
    // user has configured. Section-specific refreshes only do the named one.
    var sectionsToScrape;
    if (sectionsOverride) {
      sectionsToScrape = sectionsOverride;
    } else {
      sectionsToScrape = [LIKED_SECTION].concat(state.sections);
    }
    var triggerLabel = trigger || (sectionsOverride ? "refresh-section" : "refresh-all");
    beginReport(triggerLabel, sectionsToScrape);

    return new Promise(function(resolve, reject) {
      var allPlaylists = [];
      var allTracks = {};
      var seenIds = {};
      var failedSections = [];
      var handle = null;
      var gen = ++scrapeGeneration;
      var pendingSnapshot = null;

      function done(val) {
        if (handle) { handle.close().catch(console.error); handle = null; }
        activeScrapeHandle = null;
        finishReport(val ? "ok" : "cancelled");
        resolve(val);
      }

      function fail(err) {
        if (handle) { handle.close().catch(console.error); handle = null; }
        activeScrapeHandle = null;
        finishReport("error", err && err.message ? err.message : String(err));
        reject(err);
      }

      function captureSnapshot(label, onDone) {
        if (!handle) { if (onDone) onDone(null); return; }
        pendingSnapshot = { label: label, cb: onDone };
        handle.eval('(function(){' + SNAPSHOT_HELPER + '_snap(' + JSON.stringify(label) + ')})()');
        setTimeout(function () {
          if (pendingSnapshot && pendingSnapshot.label === label) {
            var cb = pendingSnapshot.cb;
            pendingSnapshot = null;
            if (cb) cb(null);
          }
        }, 2000);
      }

      api.network.openBrowseWindow("https://open.spotify.com", {
        title: "Spotify",
        width: 1200,
        height: 800,
        visible: !!visible,
      }).then(function(h) {
        handle = h;
        activeScrapeHandle = h;
        recordPageVisit("https://open.spotify.com", "open");
        if (h.onNavigation) {
          h.onNavigation(function (url) {
            recordPageVisit(url, "navigate");
            syncNote("nav", "Page navigated", { url: url });
          });
        }
        var loginRetries = 0;
        var loginTimer = null;

        // Single message handler -- routes to current phase handler
        var currentHandler = null;
        function setHandler(fn) {
          currentHandler = fn;
        }
        h.onMessage(function(msg) {
          if (msg.type === "window-closed") { done(null); return; }
          if (msg.type === "dbg" && msg.data) {
            plog(msg.data.level || "info", "browser:" + (msg.data.tag || "?"), msg.data.msg || "", msg.data.data);
            return;
          }
          if (msg.type === "snapshot" && msg.data) {
            if (pendingSnapshot) {
              var cb = pendingSnapshot.cb;
              var snap = msg.data;
              pendingSnapshot = null;
              if (cb) cb(snap);
            }
            return;
          }
          if (currentHandler) currentHandler(msg);
        });

        // Phase 1: Wait for login
        if (showProgress) { state.status = "waiting-login"; render(); }

        function checkLogin() {
          loginRetries++;
          if (loginRetries > 20) {
            if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            done(null);
            return;
          }
          h.eval(SCRIPT_CHECK_LOGIN);
        }

        setHandler(function(msg) {
          if (msg.type === "login-check" && msg.data && msg.data.loggedIn) {
            if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
            scrapeSections();
          }
        });

        loginTimer = setInterval(checkLogin, 3000);
        setTimeout(checkLogin, 1500);

        // Phase 2: Iterate over sections
        function scrapeSections() {
          var sectionIdx = 0;

          function nextSection() {
            if (gen !== scrapeGeneration) { done(null); return; }
            if (sectionIdx >= sectionsToScrape.length) {
              scrapeAllTracks();
              return;
            }
            var sectionName = sectionsToScrape[sectionIdx];
            sectionIdx++;

            if (showProgress) {
              state.status = "finding-section";
              state.refreshSummary = "Finding: " + sectionName;
              render();
            }

            // Liked Songs is a fixed URL, not a discoverable section. Synthesize
            // a single-playlist result and skip the home/section-finder dance.
            if (isLikedSection(sectionName)) {
              var likedPl = makeLikedPlaylist();
              if (!seenIds[likedPl.id]) {
                seenIds[likedPl.id] = true;
                allPlaylists.push(likedPl);
              }
              var likedReport = getReportSection(sectionName);
              if (likedReport) {
                likedReport.status = "ok";
                likedReport.playlistCount = 1;
              }
              dbg("flow", "section '" + sectionName + "' synthesized as /collection/tracks");
              nextSection();
              return;
            }

            // Navigate to home first (except for the first section where we're already there)
            if (sectionIdx > 1) {
              h.eval('window.location.href="https://open.spotify.com"');
            }

            // Wait for home page to render, then find section
            setTimeout(function() {
              var sectionRetries = 0;
              var musicFallbackTried = false;
              var reportSection = getReportSection(sectionName);

              function tryFindSection() {
                if (gen !== scrapeGeneration) { done(null); return; }
                sectionRetries++;
                if (reportSection) reportSection.attempts = sectionRetries;
                if (sectionRetries > 10) {
                  var giveUpFindSection = function () {
                    dbg("flow", "GAVE UP finding section: " + sectionName);
                    if (reportSection) reportSection.status = "not-found";
                    captureSnapshot("section-not-found:" + sectionName, function (snap) {
                      if (reportSection) reportSection.snapshot = snap;
                      failedSections.push(sectionName);
                      nextSection();
                    });
                  };
                  if (!musicFallbackTried) {
                    musicFallbackTried = true;
                    dbg("flow", "section '" + sectionName + "' not found, trying Music button fallback");
                    clickMusicThen(function() {
                      sectionRetries = 0;
                      tryFindSection();
                    }, giveUpFindSection);
                    return;
                  }
                  giveUpFindSection();
                  return;
                }
                h.eval(scriptFindSection(sectionName));
              }

              setHandler(function(msg) {
                if (msg.type === "section-found") {
                  recordRuleOutcome("section-find:" + sectionName, true);
                  if (showProgress) { state.status = "scraping-playlists"; render(); }
                  // Wait for section page to render, then scrape playlists
                  setTimeout(function() {
                    scrapePlaylistsForSection(sectionName, musicFallbackTried);
                  }, 4000);
                }
                if (msg.type === "section-not-found") {
                  recordRuleOutcome("section-find:" + sectionName, false);
                  setTimeout(tryFindSection, 2000);
                }
                if (msg.type === "playlists" && Array.isArray(msg.data)) {
                  var sectionPlaylists = msg.data;
                  for (var pi = 0; pi < sectionPlaylists.length; pi++) {
                    var pl = sectionPlaylists[pi];
                    if (!seenIds[pl.id]) {
                      seenIds[pl.id] = true;
                      pl.section = sectionName;
                      allPlaylists.push(pl);
                    }
                    if (pl.imageUrl) {
                      recordImageHit({
                        kind: "playlist-card-cover",
                        playlistId: pl.id, playlistName: pl.name,
                        rule: "section-card-bestImg",
                        element: "a[href*=/playlist/]",
                        url: pl.imageUrl,
                      });
                    }
                  }
                  recordRuleOutcome("section-scrape:" + sectionName, sectionPlaylists.length > 0);
                  if (reportSection) {
                    reportSection.status = "ok";
                    reportSection.playlistCount = sectionPlaylists.length;
                  }
                  dbg("flow", "section '" + sectionName + "' yielded " + sectionPlaylists.length + " playlists (" + allPlaylists.length + " total unique)");
                  nextSection();
                }
              });

              tryFindSection();
            }, sectionIdx > 1 ? 3000 : 0);
          }

          function clickMusicThen(next, giveUp) {
            if (gen !== scrapeGeneration) { done(null); return; }
            var priorHandler = currentHandler;
            var settled = false;
            function finish(found) {
              if (settled) return;
              settled = true;
              setHandler(priorHandler);
              if (found) setTimeout(next, 3000);
              else giveUp();
            }
            setHandler(function(msg) {
              if (msg.type === "music-clicked") {
                finish(!!(msg.data && msg.data.ok));
              }
            });
            handle.eval(SCRIPT_CLICK_MUSIC);
            // Safety: if the click script never responds, give up after 3s.
            setTimeout(function() { finish(false); }, 3000);
          }

          function scrapePlaylistsForSection(sectionName, musicFallbackAlreadyTried) {
            var plRetries = 0;
            var musicFallbackTried = !!musicFallbackAlreadyTried;
            var reportSection = getReportSection(sectionName);

            function tryScrapePlaylists() {
              if (gen !== scrapeGeneration) { done(null); return; }
              plRetries++;
              if (reportSection) reportSection.attempts = (reportSection.attempts || 0) + 1;
              if (plRetries > 10) {
                var giveUpScrapePlaylists = function () {
                  dbg("flow", "GAVE UP scraping playlists for section: " + sectionName);
                  if (reportSection) reportSection.status = "empty";
                  captureSnapshot("playlists-empty:" + sectionName, function (snap) {
                    if (reportSection && !reportSection.snapshot) reportSection.snapshot = snap;
                    failedSections.push(sectionName);
                    nextSection();
                  });
                };
                if (!musicFallbackTried) {
                  musicFallbackTried = true;
                  dbg("flow", "section '" + sectionName + "' playlists empty, trying Music button fallback");
                  clickMusicThen(function() {
                    plRetries = 0;
                    tryScrapePlaylists();
                  }, giveUpScrapePlaylists);
                  return;
                }
                giveUpScrapePlaylists();
                return;
              }
              h.eval(SCRIPT_SCRAPE_PLAYLISTS);
            }

            // The playlists message is already handled in setHandler above
            tryScrapePlaylists();
          }

          nextSection();
        }

        // Phase 3: Scrape tracks for all collected playlists
        function scrapeAllTracks() {
          var trackIdx = 0;

          if (showProgress) {
            state.status = "scraping-tracks";
            state.scrapeProgress = { current: 0, total: allPlaylists.length, name: "", found: 0 };
            render();
          }

          function scrapeNext() {
            if (gen !== scrapeGeneration) { done(null); return; }
            if (trackIdx >= allPlaylists.length) {
              // All done
              var result = { playlists: allPlaylists, tracks: allTracks };
              if (failedSections.length > 0) {
                result.failedSections = failedSections;
              }
              done(result);
              return;
            }
            var pl = allPlaylists[trackIdx];
            trackIdx++;
            if (showProgress) {
              state.scrapeProgress = { current: trackIdx, total: allPlaylists.length, name: pl.name, found: 0 };
              render();
            }

            var plReport = {
              id: pl.id, name: pl.name, section: pl.section || null,
              status: "pending", trackCount: 0, durationMs: 0,
              error: null, snapshot: null,
            };
            if (activeReport) activeReport.playlists.push(plReport);
            var plStart = Date.now();

            h.eval(scriptNavigatePlaylist(pl.id));

            var trackTimeout = null;
            setHandler(function(msg) {
              if (msg.type === "tracks-progress" && msg.data && msg.data.playlistId === pl.id) {
                if (showProgress) {
                  state.scrapeProgress = { current: trackIdx, total: allPlaylists.length, name: pl.name, found: msg.data.found || 0 };
                  render();
                }
                return;
              }
              if (msg.type === "tracks" && msg.data && msg.data.playlistId === pl.id) {
                if (trackTimeout) { clearTimeout(trackTimeout); trackTimeout = null; }
                var tracks = msg.data.tracks || [];
                allTracks[pl.id] = tracks;
                if (msg.data.description) pl.description = msg.data.description;
                // Liked Songs uses a locally-generated SVG cover; ignore any
                // og:image / page image (it's a generic Spotify graphic).
                if (msg.data.coverUrl && pl.id !== LIKED_PLAYLIST_ID) pl.imageUrl = msg.data.coverUrl;
                // Record cover-rule outcomes and the image we ended up with.
                var attempts = msg.data.coverRuleAttempts || [];
                for (var ra = 0; ra < attempts.length; ra++) {
                  recordRuleOutcome("cover:" + attempts[ra].rule, !!attempts[ra].ok);
                }
                if (pl.id === LIKED_PLAYLIST_ID) {
                  recordImageHit({
                    kind: "playlist-cover",
                    playlistId: pl.id, playlistName: pl.name,
                    rule: "liked-songs-svg", element: "local svg", url: "(local)",
                  });
                } else if (msg.data.coverUrl) {
                  recordImageHit({
                    kind: "playlist-cover",
                    playlistId: pl.id, playlistName: pl.name,
                    rule: msg.data.coverRule || "?",
                    element: msg.data.coverElement || null,
                    url: msg.data.coverUrl,
                  });
                  syncNote("cover", "Cover for \"" + pl.name + "\" via " + (msg.data.coverRule || "?"), {
                    element: msg.data.coverElement, url: String(msg.data.coverUrl).substring(0, 200),
                  });
                } else {
                  syncNote("cover", "No cover found for \"" + pl.name + "\"", { attempts: attempts });
                }
                // Track images
                var trackImgCount = 0;
                for (var tt = 0; tt < tracks.length; tt++) {
                  if (tracks[tt].imageUrl) {
                    trackImgCount++;
                    recordImageHit({
                      kind: "track-image",
                      playlistId: pl.id, playlistName: pl.name,
                      rule: "row-bestImg", element: "tr[role=row]",
                      url: tracks[tt].imageUrl,
                    });
                  }
                }
                if (trackImgCount > 0) {
                  syncNote("tracks", "\"" + pl.name + "\" — " + trackImgCount + "/" + tracks.length + " track images discovered");
                }
                plReport.trackCount = tracks.length;
                plReport.durationMs = Date.now() - plStart;
                if (msg.data.error) {
                  plReport.status = "error";
                  plReport.error = String(msg.data.error);
                  plog("warn", "tracks", "Scrape error for \"" + pl.name + "\" (" + pl.id + "): " + msg.data.error, { trackCount: tracks.length, durationMs: plReport.durationMs });
                  captureSnapshot("tracks-error:" + pl.id, function (snap) {
                    plReport.snapshot = snap;
                    if (snap && snap.counts) plog("warn", "tracks", "Error snapshot for \"" + pl.name + "\"", { url: snap.url, counts: snap.counts });
                    setTimeout(scrapeNext, 1000);
                  });
                  return;
                }
                if (tracks.length === 0) {
                  plReport.status = "empty";
                  plog("warn", "tracks", "Got 0 tracks for \"" + pl.name + "\" (" + pl.id + ")", { durationMs: plReport.durationMs });
                  captureSnapshot("tracks-empty:" + pl.id, function (snap) {
                    plReport.snapshot = snap;
                    if (snap && snap.counts) plog("warn", "tracks", "Empty snapshot for \"" + pl.name + "\"", { url: snap.url, counts: snap.counts, testids: (snap.testids || []).slice(0, 10) });
                    setTimeout(scrapeNext, 1000);
                  });
                  return;
                }
                plReport.status = "ok";
                setTimeout(scrapeNext, 1000);
              }
            });

            // Liked Songs can be very large, so allow far more scroll steps
            // and a correspondingly longer timeout. The scroll cadence is ~600ms
            // per step inside the page, so 600 steps caps at ~6 minutes.
            var isLiked = pl.id === LIKED_PLAYLIST_ID;
            var scrapeOpts = isLiked ? { maxSteps: 600 } : null;
            var scrapeTimeoutMs = isLiked ? 6 * 60 * 1000 : 45000;

            setTimeout(function() {
              if (gen !== scrapeGeneration) return;
              h.eval(scriptScrollThenScrape(pl.id, gen, scrapeOpts));
              trackTimeout = setTimeout(function() {
                plog("warn", "tracks", "Timeout scraping \"" + pl.name + "\" (" + pl.id + ") after " + Math.round(scrapeTimeoutMs / 1000) + "s", { elapsed: Date.now() - plStart });
                allTracks[pl.id] = allTracks[pl.id] || [];
                plReport.status = "timeout";
                plReport.durationMs = Date.now() - plStart;
                captureSnapshot("tracks-timeout:" + pl.id, function (snap) {
                  plReport.snapshot = snap;
                  if (snap && snap.counts) plog("warn", "tracks", "Timeout snapshot for \"" + pl.name + "\"", { url: snap.url, counts: snap.counts });
                  scrapeNext();
                });
              }, scrapeTimeoutMs);
            }, 4000);
          }

          scrapeNext();
        }

      }).catch(fail);
    });
  }

  // ---- Change detection ----

  function processRefreshResults(newPlaylists, newTracks) {
    var hasChanges = false;
    state.updatedPlaylistIds = {};

    // Snapshot current tracks as previous before overwriting
    var prevSnapshot = {};
    var keys = Object.keys(state.playlistTracks);
    for (var k = 0; k < keys.length; k++) {
      prevSnapshot[keys[k]] = state.playlistTracks[keys[k]];
    }
    state.previousTracks = prevSnapshot;

    var oldPlaylistMap = {};
    for (var oi = 0; oi < state.playlists.length; oi++) {
      oldPlaylistMap[state.playlists[oi].id] = state.playlists[oi];
    }

    var now = new Date().toISOString();
    for (var i = 0; i < newPlaylists.length; i++) {
      var pl = newPlaylists[i];
      var oldTracks = prevSnapshot[pl.id];
      var fresh = newTracks[pl.id] || [];
      var oldPl = oldPlaylistMap[pl.id];

      pl.lastCheckedAt = now;
      if (tracksChanged(oldTracks, fresh)) {
        hasChanges = true;
        state.updatedPlaylistIds[pl.id] = true;
        pl.updatedAt = now;
      } else if (oldPl && oldPl.updatedAt) {
        pl.updatedAt = oldPl.updatedAt;
      }
    }

    // Remove on-disk dirs for playlists that dropped out of the refresh.
    var newKeyed = {};
    for (var p = 0; p < newPlaylists.length; p++) {
      var npl = newPlaylists[p];
      newKeyed[playlistDir(npl).join("/")] = true;
    }
    for (var op = 0; op < state.playlists.length; op++) {
      var oldPl = state.playlists[op];
      var oldKey = playlistDir(oldPl).join("/");
      if (!newKeyed[oldKey]) {
        deletePlaylistFiles(oldPl);
      }
    }

    state.playlists = newPlaylists;
    state.playlistTracks = newTracks;
    saveState();
    return { hasChanges: hasChanges };
  }

  // ---- Refresh ----

  function silentRefresh() {
    if (state.refreshing) return;
    state.refreshing = true;

    performScrape(false, false, null, "auto-refresh").then(function(result) {
      state.refreshing = false;
      if (!result) {
        recordCheckResult(0, 1);
        api.ui.setBadge("spotify", { type: "dot", variant: "error" });
        return;
      }
      var outcome = processRefreshResults(result.playlists, result.tracks);
      var errCount = result.failedSections ? result.failedSections.length : 0;
      recordCheckResult(result.playlists.length, errCount);
      cacheAllImages();
      if (outcome.hasChanges) {
        api.ui.setBadge("spotify", { type: "dot", variant: "accent" });
      }
      if (errCount > 0) {
        dbg("flow", "Silent refresh: could not find sections: " + result.failedSections.join(", "));
      }
      api.scheduler.complete("auto-refresh").catch(console.error);
      state.status = "done";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      recordCheckResult(0, 1);
      console.error("Silent refresh failed:", err);
      api.ui.setBadge("spotify", { type: "dot", variant: "error" });
    });
  }

  // ---- Actions ----

  api.ui.onAction("sync", function() {
    var isFirstRun = state.playlists.length === 0;
    if (isFirstRun) {
      state.playlists = [];
      state.playlistTracks = {};
      state.updatedPlaylistIds = {};
    }
    state.status = "waiting-login";
    state.errorMessage = "";
    state.refreshSummary = "";
    state.refreshing = !isFirstRun;
    dbg("flow", isFirstRun ? "starting initial sync" : "starting refresh sync");
    render();

    performScrape(true, state.showBrowserOnRefresh, null, isFirstRun ? "sync-initial" : "sync-refresh").then(function(result) {
      state.refreshing = false;
      if (!result) {
        state.status = "error";
        state.errorMessage = "Not logged in to Spotify. Click 'Sync' to try again.";
        render();
        return;
      }
      var errCount = result.failedSections ? result.failedSections.length : 0;
      if (isFirstRun) {
        state.playlists = result.playlists;
        state.playlistTracks = result.tracks;
        if (errCount > 0) {
          state.refreshSummary = "Could not find: " + result.failedSections.join(", ");
        }
        if (state.sections.length > 0) {
          state.activeTab = "section:" + state.sections[0];
        }
        saveState();
      } else {
        processRefreshResults(result.playlists, result.tracks);
        var updatedCount = Object.keys(state.updatedPlaylistIds).length;
        var summaryParts = [];
        if (updatedCount > 0) {
          summaryParts.push("Updated " + updatedCount + " playlist" + (updatedCount > 1 ? "s" : ""));
        } else {
          summaryParts.push("No changes detected");
        }
        if (errCount > 0) {
          summaryParts.push("Could not find: " + result.failedSections.join(", "));
        }
        state.refreshSummary = summaryParts.join(". ");
      }
      recordCheckResult(result.playlists.length, errCount);
      cacheAllImages();
      state.status = "done";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      state.status = "error";
      state.errorMessage = "Sync failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  });

  api.ui.onAction("cancel", function() {
    scrapeGeneration++;
    if (activeScrapeHandle) {
      activeScrapeHandle.close().catch(console.error);
      activeScrapeHandle = null;
    }
    state.status = "idle";
    state.refreshing = false;
    render();
  });

  // Refresh just the Liked Songs synthetic playlist. Same code path as
  // refresh-section, but the trigger comes from the card's context menu.
  api.ui.onAction("refresh-liked", function() {
    if (state.refreshing) return;
    refreshSectionByName(LIKED_SECTION);
  });

  api.ui.onAction("refresh-section", function(data) {
    if (!data || !data.section) return;
    if (state.refreshing) return;
    refreshSectionByName(data.section);
  });

  function refreshSectionByName(sectionName) {
    state.refreshing = true;
    state.refreshSummary = "";
    state.status = "waiting-login";
    render();

    performScrape(true, state.showBrowserOnRefresh, [sectionName], "refresh-section:" + sectionName).then(function(result) {
      state.refreshing = false;
      if (!result) {
        state.status = "error";
        state.errorMessage = "Not logged in to Spotify.";
        render();
        return;
      }
      // Merge: remove old playlists from this section, add new ones.
      // Any old playlist in this section that didn't reappear gets its
      // on-disk directory deleted.
      var keptIds = {};
      for (var kp = 0; kp < result.playlists.length; kp++) keptIds[result.playlists[kp].id] = true;
      var kept = [];
      for (var i = 0; i < state.playlists.length; i++) {
        var oldPl = state.playlists[i];
        if (!sectionsEqual(oldPl.section, sectionName)) {
          kept.push(oldPl);
        } else if (!keptIds[oldPl.id]) {
          deletePlaylistFiles(oldPl);
        }
      }
      for (var j = 0; j < result.playlists.length; j++) {
        kept.push(result.playlists[j]);
      }
      // Merge tracks
      var newTracks = {};
      var oldKeys = Object.keys(state.playlistTracks);
      for (var k = 0; k < oldKeys.length; k++) {
        newTracks[oldKeys[k]] = state.playlistTracks[oldKeys[k]];
      }
      var resKeys = Object.keys(result.tracks);
      for (var m = 0; m < resKeys.length; m++) {
        newTracks[resKeys[m]] = result.tracks[resKeys[m]];
      }
      state.playlists = kept;
      state.playlistTracks = newTracks;
      var errCount = result.failedSections ? result.failedSections.length : 0;
      recordCheckResult(result.playlists.length, errCount);
      saveState();
      cacheAllImages();
      state.status = "done";
      state.refreshSummary = "Refreshed " + sectionName + ": " + result.playlists.length + " playlists";
      if (errCount > 0) state.refreshSummary += " (" + errCount + " error" + (errCount > 1 ? "s" : "") + ")";
      render();
    }).catch(function(err) {
      state.refreshing = false;
      state.status = "error";
      state.errorMessage = "Refresh failed: " + (err.message || err);
      recordCheckResult(0, 1);
      render();
    });
  }

  api.ui.onAction("remove-section-tab", function(data) {
    if (!data || !data.section) return;
    var name = data.section;
    if (isLikedSection(name)) return;
    var idx = -1;
    for (var i = 0; i < state.sections.length; i++) {
      if (sectionsEqual(state.sections[i], name)) { idx = i; break; }
    }
    if (idx === -1) return;
    state.sections.splice(idx, 1);
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    // Drop the section's on-disk directory and any cached playlists/tracks in memory.
    api.storage.files.remove(["playlists", sanitizeSegment(name)]).catch(console.error);
    var keptPls = [];
    for (var p = 0; p < state.playlists.length; p++) {
      if (!sectionsEqual(state.playlists[p].section, name)) {
        keptPls.push(state.playlists[p]);
      } else {
        delete state.playlistTracks[state.playlists[p].id];
      }
    }
    state.playlists = keptPls;
    state.activeTab = state.sections.length > 0 ? "section:" + state.sections[0] : "__add__";
    renderSettings();
    render();
  });

  api.ui.onAction("switch-tab", function(data) {
    if (!data || !data.tabId) return;
    if (data.tabId === "__add__") {
      state.addingSectionViaTab = true;
      render();
      return;
    }
    state.addingSectionViaTab = false;
    state.activeTab = data.tabId;
    render();
  });

  api.ui.onAction("section-tab-input", function(data) {
    if (data && data.value !== undefined) {
      pendingSectionInput = data.value;
    }
  });

  api.ui.onAction("section-tab-input:submit", function(data) {
    if (data && data.value) pendingSectionInput = data.value;
    addSectionFromTab();
  });

  api.ui.onAction("add-section-tab", function() {
    addSectionFromTab();
  });

  function addSectionFromTab() {
    var name = pendingSectionInput.trim();
    if (!name) return;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].toLowerCase() === name.toLowerCase()) return;
    }
    state.sections.push(name);
    pendingSectionInput = "";
    state.addingSectionViaTab = false;
    state.activeTab = "section:" + name;
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    renderSettings();
    render();
  }

  api.ui.onAction("cancel-add-section", function() {
    state.addingSectionViaTab = false;
    pendingSectionInput = "";
    render();
  });

  api.ui.onAction("go-home", function() {
    state.currentPlaylist = null;
    state.currentView = "home";
    render();
  });

  api.ui.onAction("view-playlist", function(data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) {
        state.currentPlaylist = state.playlists[i];
        delete state.updatedPlaylistIds[pid];
        state.currentView = "playlist";
        renderPlaylist();
        return;
      }
    }
  });

  api.ui.onAction("play-track", function(data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "track") return;
    var index = parseInt(parts[1], 10);
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (index < 0 || index >= tracks.length) return;
    // Single-track click: load only that track into the queue rather than the
    // whole playlist. Use the "Play All" / header play button to load everything.
    api.playback.playTracks(toPluginTracks([tracks[index]]), 0);
  });

  api.ui.onAction("playlist-search", function(data) {
    var pl = state.currentPlaylist;
    if (!pl) return;
    // search-input sends { query }, text-input sends { value } — accept both.
    var value = "";
    if (data) {
      if (typeof data.query === "string") value = data.query;
      else if (typeof data.value === "string") value = data.value;
    }
    state.playlistSearch[pl.id] = value;
    renderPlaylist();
  });

  api.ui.onAction("play-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    var ctx = playlistContextPayload(pl);
    api.playback.playTracks(toPluginTracks(tracks), 0, ctx);
  });

  api.ui.onAction("enqueue-current", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    api.playback.insertTracks(toPluginTracks(tracks), -1);
  });

  // ---- Context menu actions for playlist cards ----

  function findPlaylistFromData(data) {
    if (!data || !data.itemId) return null;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist") return null;
    var pid = parts.slice(1).join(":");
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === pid) return state.playlists[i];
    }
    return null;
  }

  function playlistContextPayload(pl) {
    var meta = {};
    if (pl.section) meta.Section = pl.section;
    if (pl.description) meta.Description = pl.description;
    if (pl.updatedAt) meta["Updated"] = new Date(pl.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    var title = pl.name;
    var ts = pl.lastCheckedAt || pl.updatedAt;
    if (ts) {
      var d = new Date(ts);
      var dateStr = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      meta["Retrieved"] = dateStr;
      title = pl.name + " (" + dateStr + ")";
    }
    return {
      name: pl.name,
      playlistName: title,
      coverUrl: pl.imageUrl || undefined,
      source: "spotify://playlists/" + pl.id,
      description: pl.description || null,
      metadata: meta,
    };
  }

  function parseDuration(duration) {
    if (!duration) return null;
    var parts = duration.split(":");
    if (parts.length === 2) return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    return null;
  }

  function toPluginTracks(tracks) {
    var out = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      out.push({
        path: t.spotifyId ? "spotify://" + t.spotifyId : null,
        title: t.name || "Unknown",
        artist_name: t.artist || null,
        album_title: t.album || null,
        duration_secs: parseDuration(t.duration),
        image_url: t.imageUrl || null,
      });
    }
    return out;
  }

  api.ui.onAction("play-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    var ctx = playlistContextPayload(pl);
    api.playback.playTracks(toPluginTracks(tracks), 0, ctx);
  });

  api.ui.onAction("enqueue-playlist", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    var tracks = state.playlistTracks[pl.id] || [];
    if (tracks.length === 0) return;
    api.playback.insertTracks(toPluginTracks(tracks), -1);
  });

  function savePlaylistToApp(pl) {
    var tracks = state.playlistTracks[pl.id] || [];
    var now = new Date();
    var months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    var dateStr = now.getDate() + " " + months[now.getMonth()] + " " + now.getFullYear();
    var name = pl.name + " " + dateStr;

    var trackPayloads = [];
    for (var i = 0; i < tracks.length; i++) {
      var t = tracks[i];
      trackPayloads.push({
        title: t.name || "Unknown",
        artistName: t.artist || null,
        albumName: t.album || null,
        durationSecs: parseDuration(t.duration),
        source: null,
        imageUrl: t.imageUrl || null,
      });
    }

    var plMeta = { spotifyId: pl.id };
    if (pl.section) plMeta.section = pl.section;
    if (pl.updatedAt) plMeta.sourceDate = pl.updatedAt;
    if (pl.lastCheckedAt) plMeta.lastCheckedAt = pl.lastCheckedAt;

    api.playlists.save({
      name: name,
      source: "spotify://playlists/" + pl.id,
      imageUrl: pl.imageUrl || null,
      description: pl.description || null,
      metadata: plMeta,
      tracks: trackPayloads,
    }).then(function() {
      api.ui.showNotification("Saved to Playlists: " + name);
    }).catch(function(err) {
      console.error("Failed to save playlist:", err);
      api.ui.showNotification("Failed to save playlist");
    });
  }

  api.ui.onAction("save-playlist", function() {
    var pl = state.currentPlaylist;
    if (!pl) return;
    savePlaylistToApp(pl);
  });

  api.ui.onAction("save-playlist-ctx", function(data) {
    var pl = findPlaylistFromData(data);
    if (!pl) return;
    savePlaylistToApp(pl);
  });

  // ---- Settings actions ----

  api.ui.onAction("section-input", function(data) {
    if (data && data.value !== undefined) {
      pendingSectionInput = data.value;
    }
  });

  api.ui.onAction("section-input:submit", function(data) {
    if (data && data.value) pendingSectionInput = data.value;
    var name = pendingSectionInput.trim();
    if (!name) return;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].toLowerCase() === name.toLowerCase()) return;
    }
    state.sections.push(name);
    pendingSectionInput = "";
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    renderSettings();
    render();
  });

  api.ui.onAction("add-section", function() {
    var name = pendingSectionInput.trim();
    if (!name) return;
    for (var i = 0; i < state.sections.length; i++) {
      if (state.sections[i].toLowerCase() === name.toLowerCase()) return;
    }
    state.sections.push(name);
    pendingSectionInput = "";
    api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    renderSettings();
    render();
  });

  api.ui.onAction("remove-section", function(data) {
    if (!data || data.index === undefined) return;
    var idx = data.index;
    if (idx >= 0 && idx < state.sections.length) {
      var removed = state.sections[idx];
      if (isLikedSection(removed)) return;
      state.sections.splice(idx, 1);
      api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
      if (state.activeTab === "section:" + removed) {
        state.activeTab = state.sections.length > 0 ? "section:" + state.sections[0] : "__add__";
      }
      renderSettings();
      render();
    }
  });

  api.ui.onAction("toggle-show-browser-pref", function() {
    state.showBrowserOnRefresh = !state.showBrowserOnRefresh;
    savePreferences();
    // If a scrape is in flight, apply the new visibility immediately to the
    // already-open browse window. Otherwise the change only takes effect on
    // the next sync, which surprises users.
    if (activeScrapeHandle) {
      var p = state.showBrowserOnRefresh ? activeScrapeHandle.show() : activeScrapeHandle.hide();
      p.catch(function (e) { console.error("Failed to toggle browse window visibility:", e); });
    }
    renderSettings();
    render();
  });

  // Step-by-step debugger actions
  api.ui.onAction("dbg-section-name", function(data) {
    if (data && data.value !== undefined) dbgTest.sectionName = data.value;
  });

  api.ui.onAction("dbg-start", dbgStart);
  api.ui.onAction("dbg-stop", dbgStop);

  api.ui.onAction("dbg-devtools", function() {
    if (dbgTest.handle && dbgTest.handle.devtools) {
      dbgTest.handle.devtools().catch(console.error);
    }
  });

  api.ui.onAction("dbg-select-playlist", function(data) {
    if (data && data.value !== undefined) {
      dbgTest.selectedPlaylist = data.value;
      renderSettings();
    }
  });

  api.ui.onAction("dbg-next-step", function() {
    if (dbgTest.status !== "waiting" || dbgTest.currentStep >= DBG_STEPS.length) return;
    dbgTest.status = "running";
    renderSettings();
    dbgRunStep(DBG_STEPS[dbgTest.currentStep].id);
  });

  api.ui.onAction("toggle-diagnostics", function() {
    state.showDiagnostics = !state.showDiagnostics;
    renderSettings();
  });

  api.ui.onAction("clear-diagnostics", function() {
    state.lastReport = null;
    api.storage.set("spotify_browse_reports", []).catch(console.error);
    renderSettings();
  });

  api.ui.onAction("set-auto-refresh", function(data) {
    if (!data || data.value === undefined) return;
    var hrs = parseInt(data.value, 10);
    state.autoRefreshHours = hrs;
    savePreferences();
    registerAutoRefresh();
    renderSettings();
  });

  // ---- Init: restore previous data ----

  // Load playlists from the filesystem layout (playlists/{section}/{id}/...).
  // Fall back to the legacy spotify_browse_state KV entry for a one-time
  // migration, then delete it.
  function loadInitialState() {
    loadPlaylistsFromDisk().then(function (result) {
      if (result.playlists.length > 0) {
        state.playlists = result.playlists;
        state.playlistTracks = result.tracks;
        state.status = "done";
        render();
        return;
      }
      // Fall back to legacy KV state for migration
      return api.storage.get("spotify_browse_state").then(function (saved) {
        if (saved && saved.playlists && saved.playlists.length > 0) {
          state.playlists = saved.playlists;
          state.playlistTracks = saved.playlistTracks || {};
          state.previousTracks = saved.previousTracks || {};
          state.status = "done";
          // Persist into the new filesystem layout, then drop the KV entry
          saveAllPlaylists().then(function () {
            api.storage.delete("spotify_browse_state").catch(console.error);
          }).catch(console.error);
          render();
        } else {
          render();
        }
      });
    }).catch(function (err) {
      console.error("Failed to load state:", err);
      render();
    });
  }
  loadInitialState();

  // The Archive feature has been removed. Clean up any leftover state from
  // older versions: the on-disk archives/ directory and the legacy KV key.
  api.storage.files.remove(["archives"]).catch(function () { /* no-op if missing */ });
  api.storage.delete("spotify_browse_archives").catch(console.error);

  // Load sections. Liked Songs is no longer a section — it's a pinned playlist
  // rendered above the section tabs. Strip it from any persisted list left
  // behind by a previous version.
  api.storage.get("spotify_browse_sections").then(function(sections) {
    if (sections && Array.isArray(sections)) {
      state.sections = sections;
    }
    var filtered = [];
    var changed = false;
    for (var i = 0; i < state.sections.length; i++) {
      if (isLikedSection(state.sections[i])) { changed = true; continue; }
      filtered.push(state.sections[i]);
    }
    if (changed) {
      state.sections = filtered;
      api.storage.set("spotify_browse_sections", state.sections).catch(console.error);
    }
  }).catch(console.error);

  // Load preferences
  api.storage.get("spotify_browse_preferences").then(function(prefs) {
    if (prefs) {
      state.showBrowserOnRefresh = !!prefs.showBrowserOnRefresh;
      if (prefs.autoRefreshHours !== undefined) state.autoRefreshHours = prefs.autoRefreshHours;
      if (prefs.lastCheckAt) state.lastCheckAt = prefs.lastCheckAt;
      if (prefs.lastCheckResult) state.lastCheckResult = prefs.lastCheckResult;
      registerAutoRefresh();
      renderSettings();
      render();
    }
  }).catch(console.error);

  // One-time cleanup of older legacy archive keys
  api.storage.get("spotify_browse_archive_index").then(function(index) {
    if (!index || !index.length) return;
    var promises = [];
    for (var i = 0; i < index.length; i++) {
      promises.push(api.storage.delete("spotify_browse_archive:" + index[i].storageKey));
    }
    promises.push(api.storage.delete("spotify_browse_archive_index"));
    Promise.all(promises).catch(console.error);
  }).catch(console.error);

  // One-time cleanup: the old layout was plugin-cache/{plugin}/{playlistId}/...
  // (flat, one dir per playlist id at the root). The new layout nests under
  // "playlists/{section}/{id}/", so any top-level dir that isn't "playlists"
  // is orphaned flat-layout junk.
  api.storage.listCacheDirs().then(function (dirs) {
    if (!dirs || !dirs.length) return;
    for (var d = 0; d < dirs.length; d++) {
      if (dirs[d] !== "playlists") {
        api.storage.deleteCacheDir(dirs[d]).catch(console.error);
      }
    }
  }).catch(console.error);

  function registerAutoRefresh() {
    if (state.autoRefreshHours > 0) {
      api.scheduler.register("auto-refresh", state.autoRefreshHours * 60 * 60 * 1000).catch(console.error);
    } else {
      api.scheduler.unregister("auto-refresh").catch(console.error);
    }
  }

  api.scheduler.onDue("auto-refresh", function() {
    silentRefresh();
  });
  registerAutoRefresh();

  // Load last diagnostics report
  api.storage.get("spotify_browse_reports").then(function (reports) {
    if (Array.isArray(reports) && reports.length > 0) {
      state.lastReport = reports[0];
      renderSettings();
    }
  }).catch(console.error);

  renderSettings();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
