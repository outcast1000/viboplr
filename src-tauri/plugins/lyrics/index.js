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

  provide("lrclib", function (entity) {
    if (!hasLookupKey(entity)) return Promise.resolve({ status: "not_found" });

    var url = "https://lrclib.net/api/get"
      + "?artist_name=" + encodeURIComponent(entity.artistName)
      + "&track_name=" + encodeURIComponent(entity.name);

    return lrclibFetch(url).then(function (data) {
      if (!data) return { status: "not_found" };
      // Prefer synced lyrics, fall back to plain.
      if (data.syncedLyrics && data.syncedLyrics.trim()) {
        return { status: "ok", value: { text: data.syncedLyrics, kind: "synced", _meta: LRCLIB_META } };
      }
      if (data.plainLyrics && data.plainLyrics.trim()) {
        return { status: "ok", value: { text: data.plainLyrics, kind: "plain", _meta: LRCLIB_META } };
      }
      return { status: "not_found" };
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
      result = { status: "error", message: message };
      api.log("warn", sourceName(provider) + " lookup for " + describeTrack(entity.name, entity.artistName) + " failed: " + message);
    }
    record(provider, entity, {
      status: result.status === "ok" ? "ok" : result.status === "error" ? "error" : "not_found",
      kind: result.status === "ok" && result.value ? result.value.kind : null,
      message: message,
    }, Date.now() - started, isTest);
    return result;
  }

  function record(provider, entity, outcome, ms, isTest) {
    var entry = { provider: provider, name: entity.name || "", artistName: entity.artistName || null,
                  status: outcome.status, kind: outcome.kind, message: outcome.message, ms: ms, at: Date.now(), test: !!isTest };
    if (isTest) {
      testState.results[provider] = entry;
    } else {
      var c = status.counts[provider] || (status.counts[provider] = { ok: 0, synced: 0, notFound: 0, error: 0, last: null, lastError: null });
      if (outcome.status === "ok") {
        c.ok++;
        if (outcome.kind === "synced") c.synced++;
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
      if (c.lastError) parts.push("last failure " + clock(c.lastError.at) + ": " + c.lastError.message);
    } else if (!t) {
      parts.push("No lookups yet");
    }
    return { id: source.id, title: source.name, subtitle: parts.join(" · "), badge: badgeFor(latest) };
  }

  function recentRow(entry, i) {
    var outcome = entry.status === "ok" ? found(entry) : entry.status === "error" ? "failed — " + entry.message : "nothing found";
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
