// Lyrics: the bundled web lyrics sources in one plugin. Each source is its own
// provider (contributes.providers) with its own row, priority and switch in
// Settings → Providers. They used to be two plugins (lrclib, lyrics-ovh); the
// provider ids keep those names, which is what lets the database migration
// carry their rows — and every lyric cached under them — across.

function activate(api) {
  // Both sources answer an exact artist + title lookup; neither can do
  // anything with a track missing either.
  function hasLookupKey(entity) {
    return !!(entity.name && entity.artistName);
  }
  function errorText(e) {
    return e && e.message ? e.message : String(e);
  }
  // The host's default User-Agent is browser-style, which some filtering
  // proxies block from a non-browser client; name ourselves instead.
  var FETCH_INIT = { headers: { "User-Agent": "Vibo" } };

  // Every source's answer goes through `track`, which is what the status
  // panel (Extensions → Lyrics → Configuration) reports from.
  var handlers = {};
  function provide(provider, handler) {
    handlers[provider] = handler;
    api.informationTypes.onFetch("lyrics", function (entity) {
      return track(provider, entity, false);
    }, { provider: provider });
  }

  // ── LRCLIB: synced and plain ────────────────────────────────────────

  var LRCLIB_META = { providerName: "LRCLIB", homepageUrl: "https://lrclib.net" };

  function lrclibFetch(url) {
    return api.network.fetch(url, FETCH_INIT).then(function (resp) {
      if (resp.status === 404) return null;
      if (resp.status !== 200) throw new Error("HTTP " + resp.status + " from lrclib.net");
      return resp.json();
    });
  }

  // How far a release's length may be from ours and still count as the same
  // recording. LRCLIB's own `get` allows ±2 s when given a duration (its
  // track_repository.rs: `duration - 2.0 … duration + 2.0`); the
  // search fallback uses the same window, because synced lyrics timed to a
  // different cut (radio edit, live, extended) drift out of step.
  var DURATION_TOLERANCE_SECS = 2;

  function lrclibValue(data) {
    // Prefer synced lyrics, fall back to plain.
    if (data.syncedLyrics && data.syncedLyrics.trim()) {
      return { text: data.syncedLyrics, kind: "synced", _meta: LRCLIB_META };
    }
    if (data.plainLyrics && data.plainLyrics.trim()) {
      return { text: data.plainLyrics, kind: "plain", _meta: LRCLIB_META };
    }
    return null;
  }

  // A row's words without timing: its plain lyrics, else its synced ones with
  // the [mm:ss.xx] stamps taken off.
  function lrclibPlainValue(data) {
    var text = data.plainLyrics && data.plainLyrics.trim() ? data.plainLyrics
      : (data.syncedLyrics || "").replace(/^\s*(\[\d+:\d+(?:[.:]\d+)?\]\s*)+/gm, "");
    return text.trim() ? { text: text, kind: "plain", _meta: LRCLIB_META } : null;
  }

  function knownDuration(entity) {
    var d = entity.durationSecs;
    return typeof d === "number" && isFinite(d) && d > 0 ? d : null;
  }

  // The decorations releases add to a title — "(Remastered 2011)", "[Live]",
  // "- Single Version", "feat. X" — dropped. Also what the fallback search
  // sends: LRCLIB's search matches words, so the extra ones can keep the
  // plain title's row out of the results.
  function stripDecorations(s) {
    return String(s || "")
      .replace(/\s*[([][^)\]]*[)\]]/g, " ")
      .replace(/\s+-\s+.*$/, " ")
      .replace(/\s+(feat\.?|ft\.?|featuring)\s+.*$/i, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Decorations, accents, case and punctuation off, so one song under two
  // spellings compares equal.
  function normalize(s) {
    return fold(stripDecorations(s));
  }

  // A credit's names, whole and split at the usual joins, so "Band & Guest"
  // and "Band" can match while "Other Band" and "Band" can't.
  function artistNames(s) {
    var names = [normalize(s)];
    String(s || "").split(/\s*(?:&|,|;|\/|\band\b|\bwith\b|\bx\b|\bfeat\.?|\bft\.?|\bfeaturing\b)\s*/i)
      .forEach(function (part) {
        var n = normalize(part);
        if (n && names.indexOf(n) === -1) names.push(n);
      });
    return names;
  }

  function sameArtist(a, b) {
    var left = artistNames(a);
    var right = artistNames(b);
    // Either side's full credit is one of the other's names.
    return right.indexOf(left[0]) !== -1 || left.indexOf(right[0]) !== -1;
  }

  // A synced lyric found by search is cached forever, so a wrong match would
  // stick: a row counts only when its title is the same song, its artist
  // names ours, and — when we know our length — its length is ours too.
  function acceptable(row, entity, wantTitle, duration) {
    if (row.instrumental || !lrclibValue(row)) return false;
    if (normalize(row.trackName) !== wantTitle) return false;
    if (!normalize(row.artistName) || !sameArtist(row.artistName, entity.artistName)) return false;
    if (duration == null) return true;
    return typeof row.duration === "number" && Math.abs(row.duration - duration) <= DURATION_TOLERANCE_SECS;
  }

  // Accents, case and punctuation off, decorations kept: "Song (Live)" and
  // "Song" differ here, which is what ranks the literal title first.
  function fold(s) {
    return String(s || "")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  }

  // Synced beats plain (only with a known length — without one, a search hit
  // is plain anyway); then a row carrying our title as written; then the
  // closest length.
  function pickSearchMatch(rows, entity, duration) {
    var wantTitle = normalize(entity.name);
    if (!wantTitle || !normalize(entity.artistName)) return null;
    var literal = fold(entity.name);
    function rank(row) {
      return [
        duration != null && lrclibValue(row).kind === "synced" ? 1 : 0,
        fold(row.trackName) === literal ? 1 : 0,
        duration != null ? -Math.abs(row.duration - duration) : 0,
      ];
    }
    function better(a, b) {
      for (var k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k];
      return false;
    }
    var best = null;
    var bestRank = null;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || !acceptable(row, entity, wantTitle, duration)) continue;
      var r = rank(row);
      if (!best || better(r, bestRank)) { best = row; bestRank = r; }
    }
    return best;
  }

  provide("lrclib", function (entity) {
    if (!hasLookupKey(entity)) return Promise.resolve({ status: "not_found" });

    var duration = knownDuration(entity);
    var url = "https://lrclib.net/api/get"
      + "?artist_name=" + encodeURIComponent(entity.artistName)
      + "&track_name=" + encodeURIComponent(entity.name)
      // LRCLIB takes the length as a decimal and applies its ±2 s itself;
      // rounding to whole seconds would shift that window by up to 0.5 s.
      + (duration != null ? "&duration=" + Math.round(duration * 10) / 10 : "");

    return lrclibFetch(url).then(function (data) {
      // An instrumental is LRCLIB's answer for this song — searching would
      // only find a lookalike. Any other exact hit without text is just the
      // oldest matching row (LRCLIB's `get` is `ORDER BY id LIMIT 1`, not
      // "the one with lyrics"), so another row may still have them: search.
      if (data && data.instrumental) return { status: "not_found", via: "exact" };
      var value = data ? lrclibValue(data) : null;
      if (value) return { status: "ok", value: value, via: "exact" };
      // No exact match: the tags often spell the title a little differently
      // ("Song (Remastered)"), or our length is just outside LRCLIB's window.
      // Search, and take a row only when it is plainly the same recording.
      var searchUrl = "https://lrclib.net/api/search"
        + "?track_name=" + encodeURIComponent(stripDecorations(entity.name) || entity.name)
        + "&artist_name=" + encodeURIComponent(entity.artistName);
      return lrclibFetch(searchUrl).then(function (rows) {
        var match = pickSearchMatch(Array.isArray(rows) ? rows : [], entity, duration);
        if (!match) return { status: "not_found", via: "search" };
        return {
          status: "ok",
          // Without our length nothing says the row is our cut, and synced
          // lyrics never expire — so take only its words.
          value: duration != null ? lrclibValue(match) : lrclibPlainValue(match),
          via: "search",
          matched: { name: match.trackName, artistName: match.artistName },
        };
      }, function (e) {
        // Counted as a search on the status panel, not only as a failure.
        if (e && typeof e === "object") e.lrclibVia = "search";
        throw e;
      });
    });
  });

  // ── Lyrics.ovh: plain only ──────────────────────────────────────────

  provide("lyrics-ovh", function (entity) {
    if (!hasLookupKey(entity)) return Promise.resolve({ status: "not_found" });

    var url = "https://api.lyrics.ovh/v1/"
      + encodeURIComponent(entity.artistName)
      + "/" + encodeURIComponent(entity.name);

    return api.network.fetch(url, FETCH_INIT).then(function (resp) {
      if (resp.status === 404) return { status: "not_found" };
      if (resp.status !== 200) throw new Error("HTTP " + resp.status + " from api.lyrics.ovh");
      return resp.json().then(function (data) {
        var lyrics = data && data.lyrics;
        if (!lyrics || !lyrics.trim()) return { status: "not_found" };
        return {
          status: "ok",
          value: { text: lyrics.trim(), kind: "plain", _meta: { providerName: "Lyrics.ovh", homepageUrl: "https://lyrics.ovh" } },
        };
      });
    });
  });

  // ── Status panel: what works, what fails ────────────────────────────
  //
  // Counts every answer each source gives (found / nothing found / failed)
  // with the last failure's reason, keeps the latest lookups, and can test
  // both sources against a well-known song on demand — which tells "the
  // network blocks LRCLIB" apart from "nobody has lyrics for this track".
  // Kept in plugin storage so it survives a restart. Lyrics text is never
  // stored here, only what kind came back.

  var SOURCES = [
    { id: "lrclib", name: "LRCLIB" },
    { id: "lyrics-ovh", name: "Lyrics.ovh" },
  ];
  var TEST_ITEM = { kind: "track", id: 0, name: "Karma Police", artistName: "Radiohead" };
  var PANEL = "lyrics-status";
  var STORAGE_KEY = "status";
  var RECENT_MAX = 25;

  var status = { since: Date.now(), counts: {}, recent: [] };
  var testState = { running: false, at: null, results: {} };

  function sourceName(id) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i].name;
    return id;
  }
  function describeTrack(name, artistName) {
    return "“" + name + "”" + (artistName ? " – " + artistName : "");
  }
  function clock(at) {
    var d = new Date(at);
    var sameDay = new Date().toDateString() === d.toDateString();
    var time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return sameDay ? time : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + time;
  }

  // A failure becomes `{ status: "error" }` for the chain (the next source is
  // asked) — but logged and recorded with its reason first.
  async function track(provider, entity, isTest) {
    var started = Date.now();
    var result;
    var message = null;
    try {
      result = await handlers[provider](entity);
    } catch (e) {
      message = errorText(e);
      // A failure inside LRCLIB's fallback search says so (`lrclibVia`).
      result = { status: "error", message: message, via: e && e.lrclibVia ? e.lrclibVia : null };
      api.log("warn", sourceName(provider) + " lookup for " + describeTrack(entity.name, entity.artistName) + " failed: " + message);
    }
    record(provider, entity, {
      status: result.status === "ok" ? "ok" : result.status === "error" ? "error" : "not_found",
      kind: result.status === "ok" && result.value ? result.value.kind : null,
      message: message,
      // How the answer was found (LRCLIB only): "exact" or "search", and for
      // a search hit the names it matched, so a wrong pick can be spotted.
      via: result.via || null,
      matched: result.matched || null,
    }, Date.now() - started, isTest);
    // `via` / `matched` are for the panel, not the host.
    return result.status === "ok" ? { status: "ok", value: result.value }
      : result.status === "error" ? { status: "error", message: result.message }
      : { status: "not_found" };
  }

  function record(provider, entity, outcome, ms, isTest) {
    var entry = { provider: provider, name: entity.name || "", artistName: entity.artistName || null,
                  durationSecs: knownDuration(entity), via: outcome.via, matched: outcome.matched,
                  status: outcome.status, kind: outcome.kind, message: outcome.message, ms: ms, at: Date.now(), test: !!isTest };
    if (isTest) {
      testState.results[provider] = entry;
    } else {
      var c = status.counts[provider] || (status.counts[provider] = newCounts());
      if (entry.durationSecs != null) c.withDuration = (c.withDuration || 0) + 1;
      if (outcome.via === "search") c.searched = (c.searched || 0) + 1;
      if (outcome.status === "ok") {
        c.ok++;
        if (outcome.kind === "synced") c.synced++;
        if (outcome.via === "search") c.viaSearch = (c.viaSearch || 0) + 1;
      } else if (outcome.status === "error") c.error++;
      else c.notFound++;
      c.last = entry;
      if (outcome.status === "error") c.lastError = entry;
      status.recent.unshift(entry);
      if (status.recent.length > RECENT_MAX) status.recent.length = RECENT_MAX;
      schedulePersist();
    }
    scheduleRender();
  }

  // `withDuration` / `searched` / `viaSearch` came later than the rest, so a
  // saved status may lack them — every reader treats a missing one as 0.
  function newCounts() {
    return { ok: 0, synced: 0, notFound: 0, error: 0, withDuration: 0, searched: 0, viaSearch: 0, last: null, lastError: null };
  }

  var persistTimer = null;
  function schedulePersist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      api.storage.set(STORAGE_KEY, status).catch(function (e) {
        api.log("error", "Could not save the lyrics status: " + errorText(e));
      });
    }, 5000);
  }
  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      render();
    }, 1000);
  }

  function formatLength(secs) {
    var s = Math.round(secs);
    return Math.floor(s / 60) + ":" + (s % 60 < 10 ? "0" : "") + (s % 60);
  }

  function found(entry) {
    return entry.kind === "synced" ? "synced lyrics" : "plain lyrics";
  }

  function badgeFor(entry) {
    if (!entry) return { label: "Not asked yet", variant: "muted" };
    if (entry.status === "ok") return { label: "Working", variant: "success" };
    if (entry.status === "error") return { label: "Failing", variant: "error" };
    // The test song coming back empty is suspicious; an everyday miss is not.
    return entry.test ? { label: "No match", variant: "warning" } : { label: "Working", variant: "success" };
  }

  function sourceRow(source) {
    var c = status.counts[source.id];
    var t = testState.results[source.id];
    var latest = t && (!c || !c.last || t.at >= c.last.at) ? t : c && c.last;
    var parts = [];
    if (t) {
      parts.push("Test: " + (t.status === "ok" ? found(t) + " in " + t.ms + " ms"
        : t.status === "error" ? "failed — " + t.message
        : "nothing for " + describeTrack(TEST_ITEM.name, TEST_ITEM.artistName)));
    }
    if (c) {
      parts.push(c.ok + " found (" + c.synced + " synced) · " + c.notFound + " nothing · " + c.error + " failed");
      // Only LRCLIB sends a length or falls back to a search.
      if (c.withDuration || c.searched) {
        var asked = c.ok + c.notFound + c.error;
        parts.push((c.withDuration || 0) + " of " + asked + " with the song's length · "
          + (c.searched || 0) + " searched after no exact match, " + (c.viaSearch || 0) + " found that way");
      }
      if (c.lastError) parts.push("last failure " + clock(c.lastError.at) + ": " + c.lastError.message);
    } else if (!t) {
      parts.push("No lookups yet");
    }
    return { id: source.id, title: source.name, subtitle: parts.join(" · "), badge: badgeFor(latest) };
  }

  function recentRow(entry, i) {
    var outcome = entry.status === "ok" ? found(entry) : entry.status === "error" ? "failed — " + entry.message : "nothing found";
    if (entry.via === "search") {
      outcome = entry.status === "ok" && entry.matched
        ? outcome + " via search, as " + describeTrack(entry.matched.name, entry.matched.artistName)
        : entry.status === "error" ? "search failed — " + entry.message
        : outcome + " (also searched)";
    }
    if (entry.durationSecs != null) outcome += " · " + formatLength(entry.durationSecs);
    return {
      id: "recent-" + i + "-" + entry.at,
      title: sourceName(entry.provider) + " · " + describeTrack(entry.name, entry.artistName),
      subtitle: outcome + " · " + entry.ms + " ms · " + clock(entry.at),
      badge: entry.status === "ok" ? { label: entry.kind === "synced" ? "Synced" : "Plain", variant: "success" }
        : entry.status === "error" ? { label: "Failed", variant: "error" }
        : { label: "Nothing", variant: "muted" },
    };
  }

  function render() {
    var children = [
      { type: "text", content: "What each source answered since " + clock(status.since) + ". The order they are asked in, and which ones are on, is set in Settings → Providers — lyrics in your own files are tried before both, and a source switched off there is never asked." },
      {
        type: "toolbar",
        title: "Sources",
        buttons: [
          { label: testState.running ? "Testing…" : "Test all sources", action: "lyrics-test", variant: "accent", disabled: testState.running },
          { label: "Reset counts", action: "lyrics-reset", variant: "secondary", disabled: testState.running },
        ],
        status: testState.at ? "Last test " + clock(testState.at) + " (" + describeTrack(TEST_ITEM.name, TEST_ITEM.artistName) + ")" : undefined,
      },
      { type: "track-row-list", items: SOURCES.map(sourceRow), contextMenu: false, artwork: "cached" },
      {
        type: "section",
        title: "Recent lookups",
        children: status.recent.length > 0
          ? [{ type: "track-row-list", items: status.recent.map(recentRow), contextMenu: false, artwork: "cached" }]
          : [{ type: "text", content: "Nothing asked yet. Lyrics are looked up when a song that has none cached is shown." }],
      },
    ];
    api.ui.setViewData(PANEL, { type: "layout", direction: "vertical", children: children });
  }

  async function runTests() {
    if (testState.running) return;
    testState.running = true;
    testState.results = {};
    render();
    for (var i = 0; i < SOURCES.length; i++) {
      await track(SOURCES[i].id, TEST_ITEM, true);
      render();
    }
    testState.running = false;
    testState.at = Date.now();
    render();
  }

  api.ui.onAction("lyrics-test", function () {
    runTests();
  });
  api.ui.onAction("lyrics-reset", function () {
    status = { since: Date.now(), counts: {}, recent: [] };
    testState.results = {};
    testState.at = null;
    schedulePersist();
    render();
  });

  render();
  api.storage.get(STORAGE_KEY).then(function (saved) {
    if (!saved || typeof saved !== "object" || !saved.counts) return;
    // Lookups may already have landed while this read was in flight: merge.
    Object.keys(saved.counts).forEach(function (key) {
      var s = saved.counts[key];
      var c = status.counts[key];
      if (!c) { status.counts[key] = s; return; }
      c.ok += s.ok || 0;
      c.synced += s.synced || 0;
      c.notFound += s.notFound || 0;
      c.error += s.error || 0;
      c.withDuration = (c.withDuration || 0) + (s.withDuration || 0);
      c.searched = (c.searched || 0) + (s.searched || 0);
      c.viaSearch = (c.viaSearch || 0) + (s.viaSearch || 0);
      if (!c.lastError) c.lastError = s.lastError || null;
    });
    status.since = Math.min(status.since, saved.since || status.since);
    status.recent = status.recent.concat(Array.isArray(saved.recent) ? saved.recent : []).slice(0, RECENT_MAX);
    render();
  }).catch(function (e) {
    api.log("error", "Could not read the saved lyrics status: " + errorText(e));
  });

  // ── Assistant tool ──────────────────────────────────────────────────
  // Free-text LRCLIB catalog search — for an AI resolving a track whose exact
  // metadata missed (the lookups above are exact-match).
  if (api.assistant) {
    api.assistant.onTool("search_lyrics", function (args) {
      var query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return Promise.reject(new Error('"query" (string) is required'));
      var limit = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 10));
      return lrclibFetch("https://lrclib.net/api/search?q=" + encodeURIComponent(query)).then(function (rows) {
        rows = rows || [];
        return {
          matches: rows.slice(0, limit).map(function (r) {
            return {
              trackName: r.trackName,
              artistName: r.artistName,
              albumName: r.albumName || null,
              durationSecs: r.duration || null,
              hasSynced: !!(r.syncedLyrics && r.syncedLyrics.trim()),
              hasPlain: !!(r.plainLyrics && r.plainLyrics.trim()),
            };
          }),
        };
      });
    });
  }
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
