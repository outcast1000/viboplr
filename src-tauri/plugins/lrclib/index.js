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
          value: { text: syncedLyrics, kind: "synced" },
        };
      }

      if (plainLyrics && plainLyrics.trim()) {
        return {
          status: "ok",
          value: { text: plainLyrics, kind: "plain" },
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
