// AllMusic Plugin for Viboplr
// Provides artist biographies from AllMusic as a fallback provider

function activate(api) {
  var BASE_SEARCH = "https://www.allmusic.com/search/artists/";
  var BASE_ARTIST = "https://www.allmusic.com/artist/";

  function allMusicFetch(url) {
    return api.network.fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" }
    }).then(function (resp) {
      if (resp.status !== 200) throw new Error("HTTP " + resp.status);
      return resp.text();
    });
  }

  // --- Search ---

  function searchArtist(name) {
    var url = BASE_SEARCH + encodeURIComponent(name);
    return allMusicFetch(url).then(function (html) {
      var match = html.match(/href="\/artist\/([^"]*-mn\d{10})"/);
      if (!match) return null;
      return { url: BASE_ARTIST + match[1] };
    });
  }

  // --- HTML parsing helpers ---

  function stripInlineImages(html) {
    return html.replace(/<span class="inlineImage[\s\S]*?<\/span>/g, "");
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, "");
  }

  function cleanText(text) {
    return text.replace(/\s+/g, " ").trim();
  }

  // --- Bio fetcher ---

  function getArtistBio(artistUrl) {
    var url = artistUrl + "/biographyAjax";
    return allMusicFetch(url).then(function (html) {
      // Isolate biography div
      var bioMatch = html.match(/<div id="biography"[^>]*>([\s\S]*?)(?:<\/div>\s*<div|$)/);
      if (!bioMatch) return null;
      var content = bioMatch[1];

      // Remove inline album images
      content = stripInlineImages(content);

      // Extract and remove heading
      content = content.replace(/<h2>[\s\S]*?<\/h2>/, "");

      // Extract paragraphs
      var paragraphs = [];
      var pRegex = /<p[^>]*>([\s\S]*?)<\/p>/g;
      var pMatch;
      while ((pMatch = pRegex.exec(content)) !== null) {
        var text = cleanText(stripTags(pMatch[1]));
        if (text) paragraphs.push(text);
      }

      if (paragraphs.length === 0) return null;

      var summary = paragraphs[0];
      var full = paragraphs.join("\n\n");

      return {
        summary: summary,
        full: full,
        _meta: { url: artistUrl, providerName: "AllMusic" },
      };
    });
  }

  // --- onFetch handler ---

  api.informationTypes.onFetch("artist_bio", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    return searchArtist(entity.name).then(function (found) {
      if (!found) return { status: "not_found" };
      return getArtistBio(found.url).then(function (result) {
        if (!result) return { status: "not_found" };
        return { status: "ok", value: result };
      });
    }).catch(function () { return { status: "error" }; });
  });
}

return { activate: activate };
