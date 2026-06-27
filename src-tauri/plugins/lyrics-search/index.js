// Lyrics Search — search the lyrics cached in the library and jump to the
// matching track.
//
// Lyrics live in the host's `information_values` cache (populated when you view
// a track's Lyrics tab, e.g. via LRCLIB). This view is a thin shell over the
// generic `api.informationTypes.searchValues` host API: it searches the "lyrics"
// info type, scoped to the `$.text` field, and asks the host to resolve each
// track-entity match back to a playable library track. Any plugin can use the
// same API for other info types (bios, reviews, …) by passing a different
// `typeId` / `jsonPath`.

function activate(api) {
  var VIEW = "lyrics-search";

  var state = {
    query: "",
    results: [],
    searching: false,
    error: null,
    searched: false, // becomes true after the first search so we can show "no results"
  };

  function fmtDuration(secs) {
    if (secs == null || isNaN(secs)) return "";
    secs = Math.round(secs);
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function render() {
    var children = [
      {
        type: "search-input",
        placeholder: "Search lyrics… (e.g. \"hello darkness\")",
        action: "search",
        value: state.query,
        submitOnly: true,
        buttonLabel: "Search",
      },
    ];

    if (state.searching) {
      children.push({ type: "loading", message: "Searching lyrics…" });
    } else if (state.error) {
      children.push({ type: "text", content: state.error, className: "plugin-error" });
    } else if (state.results.length > 0) {
      children.push({
        type: "text",
        content:
          state.results.length +
          " match" +
          (state.results.length === 1 ? "" : "es") +
          " for “" + state.query + "”",
        className: "plugin-muted",
      });
      children.push({
        type: "track-row-list",
        selectable: true,
        numbered: true,
        actions: [{ id: "play", label: "Play", icon: "▶" }],
        items: state.results.map(function (r, i) {
          var t = r.track || {};
          var artist = t.artist_name || "Unknown artist";
          return {
            id: "hit:" + i,
            title: t.title || "Untitled",
            subtitle: artist + " — “" + r.snippet + "”",
            // Metadata so the host resolves artwork (album→artist) and the
            // right-click menu / drag-to-queue can act on real tracks.
            artistName: t.artist_name || null,
            albumTitle: t.album_title || null,
            path: t.path || null,
            durationSecs: t.duration_secs != null ? t.duration_secs : null,
            duration: fmtDuration(t.duration_secs),
            action: "play",
          };
        }),
      });
    } else if (state.searched) {
      children.push({
        type: "text",
        content: state.query
          ? "No saved lyrics match “" + state.query + "”."
          : "Type a word or line to search your saved lyrics.",
        className: "plugin-muted",
      });
    } else {
      children.push({
        type: "text",
        content:
          "Search the lyrics cached in your library. Lyrics are saved when you " +
          "view them on a track's page (the Lyrics tab / LRCLIB).",
        className: "plugin-muted",
      });
    }

    api.ui.setViewData(
      VIEW,
      { type: "layout", direction: "vertical", children: children },
      { scrollKey: "results" }
    );
  }

  function runSearch(raw) {
    var q = String(raw == null ? "" : raw).trim();
    state.query = q;
    state.searched = true;
    state.error = null;

    if (!q) {
      state.results = [];
      state.searching = false;
      render();
      return;
    }
    if (!api.informationTypes || typeof api.informationTypes.searchValues !== "function") {
      state.error = "This version of Viboplr doesn't support lyrics search.";
      state.searching = false;
      render();
      return;
    }

    state.searching = true;
    render();
    api.informationTypes
      .searchValues(q, {
        typeId: "lyrics",
        jsonPath: "$.text",
        resolveTracks: true,
        limit: 100,
      })
      .then(
        function (matches) {
          // Keep only matches we resolved to a playable library track.
          state.results = (Array.isArray(matches) ? matches : []).filter(function (m) {
            return m && m.track;
          });
          state.searching = false;
          render();
        },
        function (e) {
          console.error("lyrics-search: search failed:", e);
          state.error = "Search failed: " + e;
          state.searching = false;
          render();
        }
      );
  }

  api.ui.onAction("search", function (data) {
    runSearch(data && (data.query != null ? data.query : data.value));
  });

  api.ui.onAction("play", function (data) {
    var id = data && data.itemId;
    if (!id) return;
    var idx = parseInt(String(id).split(":")[1], 10);
    if (isNaN(idx) || idx < 0 || idx >= state.results.length) return;

    // Play just the clicked track (use the right-click menu to play/enqueue a
    // multi-selection).
    var t = state.results[idx].track || {};
    api.playback.playTracks(
      [{
        path: t.path,
        title: t.title,
        artist_name: t.artist_name || null,
        album_title: t.album_title || null,
        duration_secs: t.duration_secs != null ? t.duration_secs : null,
      }],
      0,
      { name: "Lyrics: " + state.query, source: "lyrics-search" }
    );
  });

  render();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
