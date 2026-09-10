function activate(api) {
  // NOTE: iTunes Search does NOT provide artist photos. The `musicArtist`
  // entity returns no `artworkUrl100` field, so an artist provider here can
  // never succeed (it always falls through to not_found). Only album artwork
  // is available, so this plugin contributes album images only.

  // Normalize a name the way the backend does (strip_diacritics + unicode_lower):
  // NFD decompose, drop combining marks, lowercase, and strip punctuation/whitespace
  // while preserving letters/numbers of all scripts (so non-latin names survive).
  function normName(s) {
    if (!s) return "";
    return String(s)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  }
  function nameMatches(query, candidate) {
    var q = normName(query);
    var c = normName(candidate);
    return q.length > 0 && q === c;
  }

  // Assistant tool: multi-candidate cover search — the chain provider below
  // auto-picks one hit; a model choosing between editions wants the list.
  if (api.assistant) {
    api.assistant.onTool("search_album_art", async function (args) {
      var query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error('"query" (string) is required');
      var limit = Math.min(10, Math.max(1, parseInt(args.limit, 10) || 5));
      var resp = await api.network.fetch(
        "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=album&limit=" + limit
      );
      var data = await resp.json();
      var hits = (data && data.results) || [];
      return {
        candidates: hits.filter(function (h) { return h.artworkUrl100; }).map(function (h) {
          return {
            album: h.collectionName,
            artist: h.artistName,
            year: h.releaseDate ? parseInt(h.releaseDate.slice(0, 4), 10) : null,
            imageUrl: h.artworkUrl100.replace("100x100", "600x600"),
          };
        }),
      };
    });
  }

  api.imageProviders.onFetch("album", async function (name, artistName) {
    var term = artistName
      ? encodeURIComponent(artistName) + "+" + encodeURIComponent(name)
      : encodeURIComponent(name);
    var resp = await api.network.fetch(
      "https://itunes.apple.com/search?term=" + term + "&entity=album&limit=1"
    );
    var data = await resp.json();
    var result = data && data.results && data.results[0];
    if (!result || !result.artworkUrl100) return { status: "not_found" };
    // Gate on artist only (not title): a wrong artist means a wrong cover
    // (e.g. "Women" by Women -> a Chris Crack album), but the title legitimately
    // varies across reissues ("Homogenic" -> "Homogenic Live"), so matching the
    // title strictly would reject correct deluxe/live/remastered covers.
    if (artistName && !nameMatches(artistName, result.artistName)) return { status: "not_found" };
    var url = result.artworkUrl100.replace("100x100", "600x600");
    return { status: "ok", url: url };
  });
}

return { activate: activate };
