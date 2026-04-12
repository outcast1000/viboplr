// Genius Plugin for Viboplr
// Provides song explanations, artist descriptions, and album descriptions

function activate(api) {
  var BASE_SEARCH = "https://genius.com/api/search/multi?q=";

  function geniusFetch(url) {
    return api.network.fetch(url).then(function (resp) {
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.json();
    });
  }

  // --- Search helpers ---

  function searchSong(artist, title) {
    var query = encodeURIComponent(title + " " + artist);
    return geniusFetch(BASE_SEARCH + query).then(function (data) {
      var sections = (data && data.response && data.response.sections) || [];
      var artistLower = artist.toLowerCase();
      for (var s = 0; s < sections.length; s++) {
        var hits = sections[s].hits || [];
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (hit.type !== "song") continue;
          var result = hit.result;
          if (!result) continue;
          var hitArtist = (result.artist_names || "").toLowerCase();
          if (!hitArtist.includes(artistLower) && !artistLower.includes(hitArtist)) continue;
          if (result.id && result.url) {
            return { id: result.id, url: result.url };
          }
        }
      }
      return null;
    });
  }

  function searchArtist(name) {
    var query = encodeURIComponent(name);
    return geniusFetch(BASE_SEARCH + query).then(function (data) {
      var sections = (data && data.response && data.response.sections) || [];
      for (var s = 0; s < sections.length; s++) {
        var hits = sections[s].hits || [];
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (hit.type !== "artist") continue;
          var result = hit.result;
          if (!result || !result.id) continue;
          var url = result.url || ("https://genius.com/artists/" + result.id);
          return { id: result.id, url: url };
        }
      }
      return null;
    });
  }

  function searchAlbum(artist, title) {
    var query = encodeURIComponent(title + " " + artist);
    return geniusFetch(BASE_SEARCH + query).then(function (data) {
      var sections = (data && data.response && data.response.sections) || [];
      for (var s = 0; s < sections.length; s++) {
        var hits = sections[s].hits || [];
        for (var h = 0; h < hits.length; h++) {
          var hit = hits[h];
          if (hit.type !== "album") continue;
          var result = hit.result;
          if (!result || !result.id) continue;
          var url = result.url || ("https://genius.com/albums/" + result.id);
          return { id: result.id, url: url };
        }
      }
      return null;
    });
  }

  // --- Text normalisation (API fragments use "\n " and smart quotes;
  //     scraped lyrics use "\n" and straight quotes) ---

  function normalizeForMatch(s) {
    return s
      .replace(/\n\s+/g, "\n")
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  }

  // --- Data fetchers ---

  function getSongExplanation(songId, songUrl) {
    var songP = geniusFetch("https://genius.com/api/songs/" + songId);
    var refsP = geniusFetch(
      "https://genius.com/api/referents?song_id=" + songId + "&per_page=50&text_format=plain"
    );
    var lyricsUrl = songUrl || ("https://genius.com/songs/" + songId);
    var lyricsP = scrapeLyrics(lyricsUrl).catch(function () { return null; });
    return Promise.all([songP, refsP, lyricsP]).then(function (results) {
      var songData = results[0];
      var refsData = results[1];
      var lyricsText = results[2];

      var song = (songData && songData.response && songData.response.song) || {};
      var about = song.description_preview || undefined;
      if (about === "?" || about === "") about = undefined;
      // Keep only the first paragraph (subsequent ones contain page chrome like Contributors/Translations)
      if (about) {
        var firstPara = about.split("\n")[0].trim();
        about = firstPara || undefined;
      }
      var url = song.url || songUrl;

      var referents = (refsData && refsData.response && refsData.response.referents) || [];
      var annotations = [];
      for (var r = 0; r < referents.length; r++) {
        var ref = referents[r];
        var fragment = ref.fragment || "";
        if (!fragment || (fragment.charAt(0) === "[" && fragment.charAt(fragment.length - 1) === "]")) {
          continue;
        }
        fragment = normalizeForMatch(fragment);
        var anns = ref.annotations || [];
        for (var a = 0; a < anns.length; a++) {
          var body = anns[a].body;
          var plain = body && body.plain;
          if (plain) {
            annotations.push({ fragment: fragment, explanation: plain });
          }
        }
      }

      // Only keep annotations whose fragment actually appears in the lyrics
      if (lyricsText) {
        var lyricsNorm = normalizeForMatch(lyricsText).toLowerCase();
        annotations = annotations.filter(function (ann) {
          return lyricsNorm.indexOf(ann.fragment.toLowerCase()) !== -1;
        });
      }

      var result = {
        overview: about,
        annotations: annotations,
        _meta: { url: url, providerName: "Genius" },
      };
      if (lyricsText) result.lyrics = lyricsText;
      return result;
    });
  }

  function getArtistDescription(artistId, artistUrl) {
    return geniusFetch("https://genius.com/api/artists/" + artistId).then(function (data) {
      var artist = (data && data.response && data.response.artist) || {};
      var preview = artist.description_preview || undefined;
      if (preview === "?" || preview === "") preview = undefined;
      var desc = artist.description || {};
      var html = desc.html || undefined;
      if (html === "<p>?</p>" || html === "") html = undefined;
      var url = artist.url || artistUrl;

      if (!preview && !html) return null;

      return {
        summary: preview || "",
        full: html || undefined,
        _meta: { url: url, providerName: "Genius" },
      };
    });
  }

  function getAlbumDescription(albumId, albumUrl) {
    return geniusFetch("https://genius.com/api/albums/" + albumId).then(function (data) {
      var album = (data && data.response && data.response.album) || {};
      var preview = album.description_preview || undefined;
      if (preview === "?" || preview === "") preview = undefined;
      var desc = album.description || {};
      var html = desc.html || undefined;
      if (html === "<p>?</p>" || html === "") html = undefined;
      var url = album.url || albumUrl;

      if (!preview && !html) return null;

      return {
        summary: preview || "",
        full: html || undefined,
        _meta: { url: url, providerName: "Genius" },
      };
    });
  }

  // --- Lyrics scraping ---

  function decodeHtmlEntities(str) {
    return str
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&#x2019;/g, "\u2019");
  }

  function scrapeLyrics(url) {
    return api.network.fetch(url).then(function (resp) {
      if (resp.status !== 200) return null;
      return resp.text().then(function (html) {
        // Genius SSR renders lyrics in data-lyrics-container divs (one per verse)
        // Use lookahead to stop at next container, footer, or any non-lyrics section
        var pattern = /data-lyrics-container="true"[^>]*>([\s\S]*?)(?=<div[^>]*data-lyrics-container|<div[^>]*class="[^"]*(?:LyricsFooter|Lyrics__Footer|SongPageGrid|LyricsEditDesktop|RightSidebar)|<section|<footer|$)/g;
        var parts = [];
        var match;
        while ((match = pattern.exec(html)) !== null) {
          var block = match[1];
          // Remove elements excluded from selection (contributors, translations, etc.)
          block = block.replace(/<div[^>]*data-exclude-from-selection="true"[^>]*>[\s\S]*?<\/div>/gi, "");
          // Convert <br> to newlines
          block = block.replace(/<br\s*\/?>/gi, "\n");
          // Strip remaining HTML tags
          block = block.replace(/<[^>]+>/g, "");
          // Decode HTML entities
          block = decodeHtmlEntities(block);
          block = block.trim();
          if (!block) continue;
          parts.push(block);
        }
        if (parts.length === 0) return null;
        return parts.join("\n\n");
      });
    });
  }

  // --- onFetch handlers ---

  api.informationTypes.onFetch("song_bio", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    return searchSong(artistName, entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return geniusFetch("https://genius.com/api/songs/" + found.id).then(function (songData) {
        var song = (songData && songData.response && songData.response.song) || {};
        var about = song.description_preview || undefined;
        if (about === "?" || about === "") about = undefined;
        if (!about) return { status: "not_found" };
        var url = song.url || found.url;
        return { status: "ok", value: { summary: about, _meta: { url: url, providerName: "Genius" } } };
      });
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("song_meaning", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    return searchSong(artistName, entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getSongExplanation(found.id, found.url).then(function (result) {
        if (result.annotations.length === 0 && !result.lyrics) return { status: "not_found" };
        // Strip overview — that belongs to song_bio
        delete result.overview;
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("artist_bio", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    return searchArtist(entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getArtistDescription(found.id, found.url).then(function (result) {
        if (!result) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("album_wiki", function (entity) {
    if (entity.kind !== "album") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    return searchAlbum(artistName, entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getAlbumDescription(found.id, found.url).then(function (result) {
        if (!result) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("lyrics", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!entity.name || !artistName) return Promise.resolve({ status: "not_found" });
    return searchSong(artistName, entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return scrapeLyrics(found.url).then(function (text) {
        if (!text) return { status: "not_found" };
        return { status: "ok", value: { text: text, kind: "plain", _meta: { url: found.url, providerName: "Genius" } } };
      });
    }).catch(function () { return { status: "error" }; });
  });
}

return { activate: activate };
