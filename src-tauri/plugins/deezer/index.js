function activate(api) {
  api.imageProviders.onFetch("artist", async function (name) {
    var resp = await api.network.fetch(
      "https://api.deezer.com/search/artist?q=" + encodeURIComponent(name) + "&limit=1"
    );
    var data = await resp.json();
    var url = data && data.data && data.data[0] && data.data[0].picture_xl;
    if (!url) return { status: "not_found" };
    return { status: "ok", url: url };
  });

  api.imageProviders.onFetch("album", async function (name, artistName) {
    var query = artistName ? artistName + " " + name : name;
    var resp = await api.network.fetch(
      "https://api.deezer.com/search/album?q=" + encodeURIComponent(query) + "&limit=1"
    );
    var data = await resp.json();
    var url = data && data.data && data.data[0] && data.data[0].cover_xl;
    if (!url) return { status: "not_found" };
    return { status: "ok", url: url };
  });
}

return { activate: activate };
