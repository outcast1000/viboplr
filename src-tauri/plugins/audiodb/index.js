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

  api.imageProviders.onFetch("artist", async function (name) {
    var resp = await api.network.fetch(
      "https://theaudiodb.com/api/v1/json/2/search.php?s=" + encodeURIComponent(name)
    );
    var data = await resp.json();
    var artist = data && data.artists && data.artists[0];
    if (!artist || !artist.strArtistThumb) return { status: "not_found" };
    // Guard against a wrong first result by confirming the returned artist name
    // matches the query (normalized), so the chain can continue on a mismatch.
    if (!nameMatches(name, artist.strArtist)) return { status: "not_found" };
    return { status: "ok", url: artist.strArtistThumb };
  });
}

return { activate: activate };
