function activate(api) {
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
  // Deezer always populates picture_xl/cover_xl, even when it has no real art for
  // a matched result. In that case it returns a placeholder URL whose md5-hash
  // segment is empty (".../images/artist//1000x1000-..." — note the double
  // slash). That URL 301-redirects to HTML, not an image, so it would be saved
  // as a "failed image". Treat an empty-hash URL as no image so the provider
  // chain continues to the next provider instead.
  function hasRealImage(url) {
    if (!url) return false;
    var m = /\/images\/[^/]+\/([^/]*)\//.exec(url);
    return !!(m && m[1]);
  }

  // Assistant tool: multi-candidate art search — the chain providers below
  // auto-pick one hit; a model disambiguating a reissue or a common name
  // wants the choices.
  if (api.assistant) {
    api.assistant.onTool("search_art", async function (args) {
      var kind = args.kind;
      if (kind !== "artist" && kind !== "album") throw new Error('"kind" must be "artist" or "album"');
      var query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) throw new Error('"query" (string) is required');
      var limit = Math.min(10, Math.max(1, parseInt(args.limit, 10) || 5));
      var resp = await api.network.fetch(
        "https://api.deezer.com/search/" + kind + "?q=" + encodeURIComponent(query) + "&limit=" + limit
      );
      var data = await resp.json();
      var hits = (data && data.data) || [];
      return {
        candidates: hits.map(function (h) {
          var url = kind === "artist" ? h.picture_xl : h.cover_xl;
          return {
            name: h.name || h.title,
            artist: (h.artist && h.artist.name) || null,
            imageUrl: hasRealImage(url) ? url : null,
          };
        }).filter(function (c) { return c.imageUrl; }),
      };
    });
  }

  api.imageProviders.onFetch("artist", async function (name) {
    var resp = await api.network.fetch(
      "https://api.deezer.com/search/artist?q=" + encodeURIComponent(name) + "&limit=1"
    );
    var data = await resp.json();
    var hit = data && data.data && data.data[0];
    if (!hit || !hasRealImage(hit.picture_xl)) return { status: "not_found" };
    // Deezer searches blindly with limit=1, so a wrong-but-popular artist can be
    // returned (e.g. "Girls" -> Spice Girls). Reject mismatches so the chain
    // continues to another provider instead of caching a wrong image.
    if (!nameMatches(name, hit.name)) return { status: "not_found" };
    return { status: "ok", url: hit.picture_xl };
  });

  api.imageProviders.onFetch("album", async function (name, artistName) {
    var query = artistName ? artistName + " " + name : name;
    var resp = await api.network.fetch(
      "https://api.deezer.com/search/album?q=" + encodeURIComponent(query) + "&limit=1"
    );
    var data = await resp.json();
    var hit = data && data.data && data.data[0];
    if (!hit || !hasRealImage(hit.cover_xl)) return { status: "not_found" };
    // Gate on artist only (not title): a wrong artist means a wrong cover
    // (e.g. "Untitled" by Weezer -> Beau Wanzer), but the title legitimately
    // varies across reissues ("4" -> "4 (Expanded Edition)"), so matching the
    // title strictly would reject correct deluxe/remastered covers.
    var hitArtist = hit.artist && hit.artist.name;
    if (artistName && !nameMatches(artistName, hitArtist)) return { status: "not_found" };
    return { status: "ok", url: hit.cover_xl };
  });
}

return { activate: activate };
