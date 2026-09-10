// LRCLIB Plugin for Viboplr
// Provides synced and plain lyrics from lrclib.net

function activate(api) {
  var BASE_URL = "https://lrclib.net/api/get";

  function lrclibFetch(url) {
    return api.network.fetch(url).then(function (resp) {
      if (resp.status === 404) return null;
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.json();
    });
  }

  // Assistant tool: free-text catalog search — for an AI resolving a track
  // whose exact metadata missed (the info-type fetch above is exact-match).
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

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (!entity.name || !entity.artistName) {
      return Promise.resolve({ status: "not_found" });
    }

    var url = BASE_URL
      + "?artist_name=" + encodeURIComponent(entity.artistName)
      + "&track_name=" + encodeURIComponent(entity.name);

    return lrclibFetch(url).then(function (data) {
      if (!data) return { status: "not_found" };

      // Prefer synced lyrics, fall back to plain
      var syncedLyrics = data.syncedLyrics;
      var plainLyrics = data.plainLyrics;

      if (syncedLyrics && syncedLyrics.trim()) {
        return {
          status: "ok",
          value: { text: syncedLyrics, kind: "synced", _meta: { providerName: "LRCLIB", homepageUrl: "https://lrclib.net" } },
        };
      }

      if (plainLyrics && plainLyrics.trim()) {
        return {
          status: "ok",
          value: { text: plainLyrics, kind: "plain", _meta: { providerName: "LRCLIB", homepageUrl: "https://lrclib.net" } },
        };
      }

      return { status: "not_found" };
    }).catch(function () {
      return { status: "error" };
    });
  });
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
