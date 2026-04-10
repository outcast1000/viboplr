function activate(api) {
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function resolveWikimediaThumbnail(commonsUrl) {
    var parts = commonsUrl.split("File:");
    var filename = parts[parts.length - 1];
    var resp = await api.network.fetch(
      "https://en.wikipedia.org/w/api.php?action=query&titles=File:" +
        encodeURIComponent(filename) +
        "&prop=imageinfo&iiprop=url&iiurlwidth=500&format=json"
    );
    var data = await resp.json();
    var pages = data && data.query && data.query.pages;
    if (!pages) return null;
    var keys = Object.keys(pages);
    if (keys.length === 0) return null;
    var page = pages[keys[0]];
    var info = page && page.imageinfo && page.imageinfo[0];
    return info && info.thumburl ? info.thumburl : null;
  }

  api.imageProviders.onFetch("artist", async function (name) {
    // Step 1: Search for artist
    var searchResp = await api.network.fetch(
      "https://musicbrainz.org/ws/2/artist/?query=artist:" +
        encodeURIComponent(name) +
        "&limit=1&fmt=json"
    );
    var searchData = await searchResp.json();
    var artists = searchData && searchData.artists;
    if (!artists || artists.length === 0) return { status: "not_found" };

    var artist = artists[0];
    if (!artist.score || artist.score < 80) return { status: "not_found" };

    var mbid = artist.id;
    if (!mbid) return { status: "not_found" };

    // Step 2: Rate limit
    await sleep(1000);

    // Step 3: Get artist relations
    var artistResp = await api.network.fetch(
      "https://musicbrainz.org/ws/2/artist/" + mbid + "?inc=url-rels&fmt=json"
    );
    var artistData = await artistResp.json();
    var relations = artistData && artistData.relations;
    if (!relations) return { status: "not_found" };

    var imageRel = null;
    for (var i = 0; i < relations.length; i++) {
      if (relations[i].type === "image") {
        imageRel = relations[i];
        break;
      }
    }
    if (!imageRel || !imageRel.url || !imageRel.url.resource) return { status: "not_found" };

    var imageUrl = imageRel.url.resource;

    // Step 4: If Wikimedia Commons URL, resolve thumbnail
    if (imageUrl.indexOf("commons.wikimedia.org") !== -1) {
      await sleep(1000);
      var thumbUrl = await resolveWikimediaThumbnail(imageUrl);
      if (!thumbUrl) return { status: "not_found" };
      imageUrl = thumbUrl;
    }

    return { status: "ok", url: imageUrl };
  });

  api.imageProviders.onFetch("album", async function (name, artistName) {
    // Step 1: Search for release-group
    var query = artistName
      ? "releasegroup:" + encodeURIComponent(name) + " AND artist:" + encodeURIComponent(artistName)
      : "releasegroup:" + encodeURIComponent(name);
    var searchResp = await api.network.fetch(
      "https://musicbrainz.org/ws/2/release-group/?query=" +
        encodeURIComponent(query) +
        "&limit=1&fmt=json"
    );
    var searchData = await searchResp.json();
    var groups = searchData && searchData["release-groups"];
    if (!groups || groups.length === 0) return { status: "not_found" };

    var group = groups[0];
    if (!group.score || group.score < 80) return { status: "not_found" };

    var mbid = group.id;
    if (!mbid) return { status: "not_found" };

    // Step 2: Fetch cover art from Cover Art Archive
    await sleep(1000);
    var coverUrl = "https://coverartarchive.org/release-group/" + mbid + "/front-500";
    return { status: "ok", url: coverUrl };
  });
}

return { activate: activate };
