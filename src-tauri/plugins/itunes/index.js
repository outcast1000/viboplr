function activate(api) {
  api.imageProviders.onFetch("artist", async function (name) {
    var resp = await api.network.fetch(
      "https://itunes.apple.com/search?term=" + encodeURIComponent(name) + "&entity=musicArtist&limit=1"
    );
    var data = await resp.json();
    var result = data && data.results && data.results[0];
    if (!result || !result.artworkUrl100) return { status: "not_found" };
    var url = result.artworkUrl100.replace("100x100", "600x600");
    return { status: "ok", url: url };
  });

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
    var url = result.artworkUrl100.replace("100x100", "600x600");
    return { status: "ok", url: url };
  });
}

return { activate: activate };
