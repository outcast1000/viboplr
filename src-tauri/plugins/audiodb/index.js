function activate(api) {
  api.imageProviders.onFetch("artist", async function (name) {
    var resp = await api.network.fetch(
      "https://theaudiodb.com/api/v1/json/2/search.php?s=" + encodeURIComponent(name)
    );
    var data = await resp.json();
    var artist = data && data.artists && data.artists[0];
    if (!artist || !artist.strArtistThumb) return { status: "not_found" };
    return { status: "ok", url: artist.strArtistThumb };
  });
}

return { activate: activate };
