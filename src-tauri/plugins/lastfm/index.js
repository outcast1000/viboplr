// Last.fm Plugin for Viboplr
// Provides scrobbling, now playing, history import, and metadata

function activate(api) {
  var BASE_URL = "https://ws.audioscrobbler.com/2.0/";
  var CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms

  var state = {
    apiKey: null,
    apiSecret: null,
    sessionKey: null,
    username: null,
    importing: false,
    importCancelled: false,
    autoImportEnabled: false,
    autoImportIntervalMins: 60,
    autoImportTimerId: null,
    lastImportAt: null,
    importProgress: null,
    importResult: null,
  };

  // Deferred promise that resolves once the API key is loaded.
  // Info-type handlers wait on this so they never fire with a missing key.
  var _resolveApiKeyReady;
  var apiKeyReady = new Promise(function (resolve) { _resolveApiKeyReady = resolve; });

  // ===== MD5 Implementation (RFC 1321) =====
  // Based on public-domain code by Joseph Myers

  function md5(string) {
    function md5cycle(x, k) {
      var a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936);
      d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819);
      b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897);
      d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341);
      b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416);
      d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063);
      b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682);
      d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290);
      b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510);
      d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713);
      b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691);
      d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335);
      b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438);
      d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961);
      b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467);
      d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473);
      b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558);
      d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562);
      b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060);
      d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632);
      b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174);
      d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979);
      b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487);
      d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520);
      b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844);
      d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905);
      b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571);
      d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523);
      b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359);
      d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380);
      b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070);
      d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259);
      b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = add32(a, x[0]);
      x[1] = add32(b, x[1]);
      x[2] = add32(c, x[2]);
      x[3] = add32(d, x[3]);
    }
    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function add32(a, b) { return (a + b) & 0xFFFFFFFF; }
    function md5blk(s) {
      var md5blks = [];
      for (var i = 0; i < 64; i += 4) {
        md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) +
          (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
      }
      return md5blks;
    }
    var hex_chr = "0123456789abcdef".split("");
    function rhex(n) {
      var s = "";
      for (var j = 0; j < 4; j++) {
        s += hex_chr[(n >> (j * 8 + 4)) & 0x0F] + hex_chr[(n >> (j * 8)) & 0x0F];
      }
      return s;
    }
    function hex(x) {
      for (var i = 0; i < x.length; i++) x[i] = rhex(x[i]);
      return x.join("");
    }

    // Convert string to UTF-8 bytes then process
    var s = unescape(encodeURIComponent(string));
    var n = s.length;
    var st = [1732584193, -271733879, -1732584194, 271733878];
    var i;
    for (i = 64; i <= n; i += 64) {
      md5cycle(st, md5blk(s.substring(i - 64, i)));
    }
    s = s.substring(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < s.length; i++) {
      tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
    }
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (i > 55) {
      md5cycle(st, tail);
      for (i = 0; i < 16; i++) tail[i] = 0;
    }
    tail[14] = n * 8;
    md5cycle(st, tail);
    return hex(st);
  }

  // ===== API Signing =====

  function signParams(params) {
    params.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
    var sigInput = "";
    for (var i = 0; i < params.length; i++) {
      sigInput += params[i][0] + params[i][1];
    }
    sigInput += state.apiSecret;
    return md5(sigInput);
  }

  // ===== HTTP Helpers =====

  function lastfmGet(method, params) {
    return apiKeyReady.then(function () {
      if (!state.apiKey) throw new Error("Last.fm API key not available");
      var query = "method=" + encodeURIComponent(method)
        + "&api_key=" + encodeURIComponent(state.apiKey)
        + "&format=json";
      if (params) {
        for (var i = 0; i < params.length; i++) {
          query += "&" + encodeURIComponent(params[i][0]) + "=" + encodeURIComponent(params[i][1]);
        }
      }
      return api.network.fetch(BASE_URL + "?" + query).then(function (resp) {
        return resp.json();
      }).then(function (data) {
        if (data.error) {
          throw new Error("Last.fm error " + data.error + ": " + (data.message || "Unknown"));
        }
        return data;
      });
    });
  }

  function lastfmSignedPost(method, extra) {
    var params = [
      ["method", method],
      ["api_key", state.apiKey],
      ["sk", state.sessionKey],
    ];
    if (extra) {
      for (var i = 0; i < extra.length; i++) {
        params.push(extra[i]);
      }
    }
    var sig = signParams(params);
    // Build form body
    var body = "";
    for (var j = 0; j < params.length; j++) {
      if (body) body += "&";
      body += encodeURIComponent(params[j][0]) + "=" + encodeURIComponent(params[j][1]);
    }
    body += "&api_sig=" + encodeURIComponent(sig) + "&format=json";
    return api.network.fetch(BASE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    }).then(function (resp) {
      return resp.json();
    }).then(function (data) {
      if (data.error) {
        if (data.error === 9 || data.error === 14) {
          console.warn("[lastfm] Auth error, disconnecting");
          disconnect();
          renderSettings();
        }
        throw new Error("Last.fm error " + data.error + ": " + (data.message || "Unknown"));
      }
      return data;
    });
  }

  // ===== Caching =====

  function cacheGet(key) {
    return api.storage.get("cache:" + key).then(function (entry) {
      if (!entry) return null;
      if (Date.now() - entry.ts > CACHE_TTL) {
        api.storage.delete("cache:" + key);
        return null;
      }
      return entry.value;
    });
  }

  function cacheSet(key, value) {
    return api.storage.set("cache:" + key, { ts: Date.now(), value: value });
  }

  function cacheDeletePrefix(prefix) {
    // Plugin storage doesn't support prefix deletion, so we track known keys
    // and delete individually. For now, just delete the specific key.
    return api.storage.delete("cache:" + prefix);
  }

  // ===== Auth Flow =====

  function startAuth() {
    var url = "https://www.last.fm/api/auth/?api_key=" + encodeURIComponent(state.apiKey)
      + "&cb=" + encodeURIComponent("viboplr://lastfm-callback");
    api.network.openUrl(url);
  }

  function handleAuthCallback(token) {
    var params = [
      ["method", "auth.getSession"],
      ["api_key", state.apiKey],
      ["token", token],
    ];
    var sig = signParams(params);
    var query = "method=auth.getSession"
      + "&api_key=" + encodeURIComponent(state.apiKey)
      + "&token=" + encodeURIComponent(token)
      + "&api_sig=" + encodeURIComponent(sig)
      + "&format=json";
    return api.network.fetch(BASE_URL + "?" + query).then(function (resp) {
      return resp.json();
    }).then(function (data) {
      if (data.error) {
        throw new Error("Last.fm auth error: " + (data.message || "Unknown"));
      }
      if (!data.session || !data.session.key || !data.session.name) {
        throw new Error("Invalid session response");
      }
      state.sessionKey = data.session.key;
      state.username = data.session.name;
      return api.storage.set("lastfm_session", {
        sessionKey: state.sessionKey,
        username: state.username,
      });
    }).then(function () {
      console.log("[lastfm] Authenticated as", state.username);
      renderSettings();
    }).catch(function (err) {
      console.error("[lastfm] Auth failed:", err);
      renderSettings();
    });
  }

  function disconnect() {
    state.sessionKey = null;
    state.username = null;
    stopAutoImport();
    api.storage.delete("lastfm_session");
    api.storage.delete("lastfm_auto_import");
  }

  // Deep link handler
  api.network.onDeepLink(function (url) {
    if (url.indexOf("viboplr://lastfm-callback") !== 0) return;
    var qIndex = url.indexOf("?");
    if (qIndex === -1) return;
    var params = new URLSearchParams(url.substring(qIndex + 1));
    var token = params.get("token");
    if (token) {
      handleAuthCallback(token);
    }
  });

  // ===== Playback Hooks =====

  api.playback.onTrackStarted(function (track) {
    if (!state.sessionKey || !track) return;
    var artist = track.artist_name;
    var title = track.title;
    if (!artist || !title) return;
    var extra = [["artist", artist], ["track", title]];
    if (track.album_title) extra.push(["album", track.album_title]);
    if (track.duration_secs) extra.push(["duration", String(Math.round(track.duration_secs))]);
    lastfmSignedPost("track.updateNowPlaying", extra).catch(function (err) {
      console.warn("[lastfm] now_playing error:", err.message);
    });
  });

  api.playback.onTrackScrobbled(function (track) {
    if (!state.sessionKey || !track) return;
    var artist = track.artist_name;
    var title = track.title;
    if (!artist || !title) return;
    var ts = String(Math.floor(Date.now() / 1000));
    var extra = [["artist", artist], ["track", title], ["timestamp", ts]];
    if (track.album_title) extra.push(["album", track.album_title]);
    if (track.duration_secs) extra.push(["duration", String(Math.round(track.duration_secs))]);
    lastfmSignedPost("track.scrobble", extra).catch(function (err) {
      console.warn("[lastfm] scrobble error:", err.message);
    });
  });

  api.playback.onTrackLiked(function (track, liked) {
    if (!state.sessionKey || !track) return;
    var artist = track.artist_name;
    var title = track.title;
    if (!artist || !title) return;
    var method = liked ? "track.love" : "track.unlove";
    lastfmSignedPost(method, [["artist", artist], ["track", title]]).catch(function (err) {
      console.warn("[lastfm] " + method + " error:", err.message);
    });
  });

  // ===== Information Types =====

  var stripReadMore = function (html) {
    return (html || "")
      .replace(/<a [^>]*>Read more on Last\.fm<\/a>\.?\s*/gi, "")
      .replace(/User-contributed text is available under the Creative Commons[^.]*\.\s*(additional terms may apply\.)?\s*/gi, "")
      .trim();
  };

  function fetchArtistInfo(artistName) {
    var cacheKey = "artist_info:" + artistName.toLowerCase();
    return cacheGet(cacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("artist.getInfo", [["artist", artistName], ["autocorrect", "1"]]).then(function (data) {
        cacheSet(cacheKey, data);
        return data;
      });
    });
  }

  function fetchAlbumInfo(artistName, albumName) {
    var cacheKey = "album_info:" + artistName.toLowerCase() + ":" + albumName.toLowerCase();
    return cacheGet(cacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("album.getInfo", [["artist", artistName], ["album", albumName], ["autocorrect", "1"]]).then(function (data) {
        cacheSet(cacheKey, data);
        return data;
      });
    });
  }

  // --- Artist info types ---

  api.informationTypes.onFetch("artist_bio", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    return fetchArtistInfo(entity.name).then(function (data) {
      if (!data || !data.artist || !data.artist.bio || !data.artist.bio.summary) {
        return { status: "not_found" };
      }
      var artistUrl = (data.artist.url) || ("https://www.last.fm/music/" + encodeURIComponent(entity.name));
      return {
        status: "ok",
        value: {
          summary: stripReadMore(data.artist.bio.summary),
          full: stripReadMore(data.artist.bio.content) || undefined,
          _meta: { url: artistUrl, providerName: "Last.fm" },
        },
      };
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("artist_stats", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    return fetchArtistInfo(entity.name).then(function (data) {
      if (!data || !data.artist || !data.artist.stats) return { status: "not_found" };
      var items = [];
      if (data.artist.stats.listeners) items.push({ label: "listeners", value: Number(data.artist.stats.listeners) });
      if (data.artist.stats.playcount) items.push({ label: "scrobbles", value: Number(data.artist.stats.playcount) });
      if (items.length === 0) return { status: "not_found" };
      return { status: "ok", value: { items: items, _meta: { providerName: "Last.fm", homepageUrl: "https://www.last.fm" } } };
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("similar_artists", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    var cacheKey = "similar_artists:" + entity.name.toLowerCase();
    return cacheGet(cacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("artist.getSimilar", [["artist", entity.name], ["autocorrect", "1"], ["limit", "20"]]).then(function (data) {
        cacheSet(cacheKey, data);
        return data;
      });
    }).then(function (data) {
      if (!data || !data.similarartists || !data.similarartists.artist) return { status: "not_found" };
      var list = Array.isArray(data.similarartists.artist) ? data.similarartists.artist : [data.similarartists.artist];
      if (list.length === 0) return { status: "not_found" };
      var items = [];
      for (var i = 0; i < list.length; i++) {
        var sa = list[i];
        items.push({
          name: sa.name,
          match: parseFloat(sa.match || "0"),
          libraryKind: "artist",
        });
      }
      var artistUrl = "https://www.last.fm/music/" + encodeURIComponent(entity.name);
      return { status: "ok", value: { items: items, _meta: { url: artistUrl + "/+similar", providerName: "Last.fm" } } };
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("artist_top_tracks", function (entity) {
    if (entity.kind !== "artist") return Promise.resolve({ status: "not_found" });
    var cacheKey = "artist_top_tracks:" + entity.name.toLowerCase();
    return cacheGet(cacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("artist.getTopTracks", [["artist", entity.name], ["autocorrect", "1"], ["limit", "50"]]).then(function (data) {
        cacheSet(cacheKey, data);
        return data;
      });
    }).then(function (data) {
      if (!data || !data.toptracks || !data.toptracks.track) return { status: "not_found" };
      var tracks = Array.isArray(data.toptracks.track) ? data.toptracks.track : [data.toptracks.track];
      if (tracks.length === 0) return { status: "not_found" };
      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        items.push({
          name: tracks[i].name,
          value: parseInt(tracks[i].listeners || tracks[i].playcount || "0", 10),
          libraryKind: "track",
        });
      }
      return { status: "ok", value: { items: items, _meta: { url: "https://www.last.fm/music/" + encodeURIComponent(entity.name) + "/+tracks", providerName: "Last.fm" } } };
    }).catch(function () { return { status: "error" }; });
  });

  // --- Album info types ---

  api.informationTypes.onFetch("album_wiki", function (entity) {
    if (entity.kind !== "album") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    return fetchAlbumInfo(artistName, entity.name).then(function (data) {
      if (!data || !data.album || !data.album.wiki || !data.album.wiki.summary) return { status: "not_found" };
      var albumUrl = (data.album.url) || ("https://www.last.fm/music/" + encodeURIComponent(artistName) + "/" + encodeURIComponent(entity.name));
      return {
        status: "ok",
        value: {
          summary: stripReadMore(data.album.wiki.summary),
          full: stripReadMore(data.album.wiki.content) || undefined,
          _meta: { url: albumUrl, providerName: "Last.fm" },
        },
      };
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("album_track_popularity", function (entity) {
    if (entity.kind !== "album") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    // album.getInfo doesn't include per-track listeners, so we need to
    // fetch track.getInfo for each track individually
    var popCacheKey = "album_track_pop:" + artistName.toLowerCase() + ":" + entity.name.toLowerCase();
    return cacheGet(popCacheKey).then(function (cached) {
      if (cached) return cached;
      return fetchAlbumInfo(artistName, entity.name).then(function (data) {
        if (!data || !data.album || !data.album.tracks || !data.album.tracks.track) return null;
        var tracks = Array.isArray(data.album.tracks.track) ? data.album.tracks.track : [data.album.tracks.track];
        if (tracks.length === 0) return null;
        var fetches = [];
        for (var i = 0; i < tracks.length; i++) {
          (function (trackName) {
            fetches.push(
              lastfmGet("track.getInfo", [["artist", artistName], ["track", trackName], ["autocorrect", "1"]])
                .then(function (info) {
                  var listeners = parseInt((info.track && info.track.listeners) || "0", 10);
                  return { name: trackName, listeners: listeners };
                })
                .catch(function () { return { name: trackName, listeners: 0 }; })
            );
          })(tracks[i].name);
        }
        return Promise.all(fetches).then(function (results) {
          cacheSet(popCacheKey, results);
          return results;
        });
      });
    }).then(function (results) {
      if (!results) return { status: "not_found" };
      var items = [];
      for (var i = 0; i < results.length; i++) {
        items.push({ name: results[i].name, subtitle: artistName, value: results[i].listeners, libraryKind: "track" });
      }
      var albumUrl = "https://www.last.fm/music/" + encodeURIComponent(entity.artistName) + "/" + encodeURIComponent(entity.name);
      return { status: "ok", value: { items: items, _meta: { url: albumUrl, providerName: "Last.fm" } } };
    }).catch(function () { return { status: "error" }; });
  });

  // --- Track info types ---

  api.informationTypes.onFetch("track_info", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    var cacheKey = "track_info:" + artistName.toLowerCase() + ":" + entity.name.toLowerCase();
    return cacheGet(cacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("track.getInfo", [["artist", artistName], ["track", entity.name], ["autocorrect", "1"]]).then(function (data) {
        cacheSet(cacheKey, data);
        return data;
      });
    }).then(function (data) {
      if (!data || !data.track) return { status: "not_found" };
      var t = data.track;
      var items = [];
      if (t.listeners) items.push({ label: "listeners", value: Number(t.listeners) });
      if (t.playcount) items.push({ label: "scrobbles", value: Number(t.playcount) });
      if (items.length === 0) return { status: "not_found" };
      var trackUrl = t.url || ("https://www.last.fm/music/" + encodeURIComponent(artistName) + "/_/" + encodeURIComponent(entity.name));
      return {
        status: "ok",
        value: {
          items: items,
          toptags: (t.toptags && t.toptags.tag) ? (Array.isArray(t.toptags.tag) ? t.toptags.tag : [t.toptags.tag]) : [],
          url: trackUrl,
          _meta: { url: trackUrl, providerName: "Last.fm" },
        },
      };
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("track_tags", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    var trackCacheKey = "track_tags:" + artistName.toLowerCase() + ":" + entity.name.toLowerCase();
    var artistCacheKey = "artist_tags:" + artistName.toLowerCase();

    var trackTagsP = cacheGet(trackCacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("track.getTopTags", [["artist", artistName], ["track", entity.name], ["autocorrect", "1"]]).then(function (data) {
        cacheSet(trackCacheKey, data);
        return data;
      });
    });

    var artistTagsP = cacheGet(artistCacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("artist.getTopTags", [["artist", artistName], ["autocorrect", "1"]]).then(function (data) {
        cacheSet(artistCacheKey, data);
        return data;
      });
    });

    return Promise.all([trackTagsP, artistTagsP]).then(function (results) {
      var trackData = results[0];
      var artistData = results[1];
      var tags = [];
      var artistTags = [];
      if (trackData && trackData.toptags && trackData.toptags.tag) {
        var tt = Array.isArray(trackData.toptags.tag) ? trackData.toptags.tag : [trackData.toptags.tag];
        for (var i = 0; i < tt.length; i++) {
          if (tt[i].name) tags.push({ name: tt[i].name, url: tt[i].url });
        }
      }
      if (artistData && artistData.toptags && artistData.toptags.tag) {
        var at = Array.isArray(artistData.toptags.tag) ? artistData.toptags.tag : [artistData.toptags.tag];
        for (var j = 0; j < at.length; j++) {
          if (at[j].name) artistTags.push({ name: at[j].name, url: at[j].url });
        }
      }
      if (tags.length === 0 && artistTags.length === 0) return { status: "not_found" };
      return { status: "ok", value: { tags: tags, artistTags: artistTags, suggestable: true, _meta: { providerName: "Last.fm", homepageUrl: "https://www.last.fm" } } };
    }).catch(function () { return { status: "error" }; });
  });

  api.informationTypes.onFetch("similar_tracks", function (entity) {
    if (entity.kind !== "track") return Promise.resolve({ status: "not_found" });
    var artistName = entity.artistName || "";
    if (!artistName) return Promise.resolve({ status: "not_found" });
    var cacheKey = "similar_tracks:" + artistName.toLowerCase() + ":" + entity.name.toLowerCase();
    return cacheGet(cacheKey).then(function (cached) {
      if (cached) return cached;
      return lastfmGet("track.getSimilar", [["artist", artistName], ["track", entity.name], ["autocorrect", "1"], ["limit", "20"]]).then(function (data) {
        cacheSet(cacheKey, data);
        return data;
      });
    }).then(function (data) {
      if (!data || !data.similartracks || !data.similartracks.track) return { status: "not_found" };
      var tracks = Array.isArray(data.similartracks.track) ? data.similartracks.track : [data.similartracks.track];
      if (tracks.length === 0) return { status: "not_found" };
      var items = [];
      for (var i = 0; i < tracks.length; i++) {
        var st = tracks[i];
        var artist = (st.artist && (st.artist.name || st.artist["#text"])) || "";
        items.push({
          name: st.name,
          subtitle: artist,
          value: Math.round(parseFloat(st.match || "0") * 100),
          libraryKind: "track",
        });
      }
      return { status: "ok", value: { items: items, _meta: { providerName: "Last.fm", homepageUrl: "https://www.last.fm" } } };
    }).catch(function () { return { status: "error" }; });
  });

  // ===== History Import =====

  function importHistory(fromTs) {
    if (state.importing || !state.sessionKey || !state.username) return;
    state.importing = true;
    state.importCancelled = false;
    state.importProgress = null;
    state.importResult = null;
    renderSettings();

    var username = state.username;
    var totalImported = 0;
    var totalSkipped = 0;

    function fetchPage(page, totalPages) {
      if (state.importCancelled) {
        finishImport(totalImported, totalSkipped);
        return;
      }

      var params = [
        ["user", username],
        ["page", String(page)],
        ["limit", "200"],
      ];
      if (fromTs) {
        params.push(["from", String(fromTs)]);
      }

      lastfmGet("user.getRecentTracks", params).then(function (data) {
        var rt = data.recenttracks;
        if (!rt || !rt.track) {
          finishImport(totalImported, totalSkipped);
          return;
        }

        var attr = rt["@attr"] || {};
        var tp = parseInt(attr.totalPages || "1", 10);
        if (totalPages === null) totalPages = tp;

        // Extract plays
        var tracks = Array.isArray(rt.track) ? rt.track : [rt.track];
        var plays = [];
        for (var i = 0; i < tracks.length; i++) {
          var t = tracks[i];
          // Skip "now playing" entries (no date)
          if (t["@attr"] && t["@attr"].nowplaying === "true") continue;
          if (!t.date || !t.date.uts) continue;
          var artist = (t.artist && (t.artist["#text"] || t.artist.name)) || "";
          var name = t.name || "";
          var playedAt = parseInt(t.date.uts, 10);
          if (artist && name && playedAt) {
            plays.push({ artist: artist, track: name, playedAt: playedAt });
          }
        }

        if (plays.length === 0) {
          finishImport(totalImported, totalSkipped);
          return;
        }

        return api.library.recordHistoryPlaysBatch(plays).then(function (result) {
          totalImported += result.imported;
          totalSkipped += result.skipped;

          state.importProgress = {
            page: page,
            total_pages: totalPages,
            imported: totalImported,
            skipped: totalSkipped,
          };
          renderSettings();

          if (page < totalPages) {
            // Rate limit: 200ms between pages
            setTimeout(function () {
              fetchPage(page + 1, totalPages);
            }, 200);
          } else {
            finishImport(totalImported, totalSkipped);
          }
        });
      }).catch(function (err) {
        console.error("[lastfm] import error:", err);
        state.importing = false;
        state.importProgress = null;
        renderSettings();
      });
    }

    function finishImport(imported, skipped) {
      state.importing = false;
      state.importProgress = null;
      state.importResult = { imported: imported, skipped: skipped };
      state.lastImportAt = Math.floor(Date.now() / 1000);
      api.storage.set("lastfm_auto_import", {
        enabled: state.autoImportEnabled,
        intervalMins: state.autoImportIntervalMins,
        lastImportAt: state.lastImportAt,
      });
      renderSettings();
    }

    fetchPage(1, null);
  }

  function cancelImport() {
    state.importCancelled = true;
  }

  // ===== Auto Import =====

  function startAutoImport() {
    if (state.autoImportTimerId) return;
    state.autoImportEnabled = true;
    state.autoImportTimerId = setInterval(function () {
      if (!state.sessionKey || state.importing) return;
      importHistory(state.lastImportAt);
    }, state.autoImportIntervalMins * 60 * 1000);
    api.storage.set("lastfm_auto_import", {
      enabled: true,
      intervalMins: state.autoImportIntervalMins,
      lastImportAt: state.lastImportAt,
    });
  }

  function stopAutoImport() {
    state.autoImportEnabled = false;
    if (state.autoImportTimerId) {
      clearInterval(state.autoImportTimerId);
      state.autoImportTimerId = null;
    }
    api.storage.set("lastfm_auto_import", {
      enabled: false,
      intervalMins: state.autoImportIntervalMins,
      lastImportAt: state.lastImportAt,
    });
  }

  // ===== Settings Panel =====

  function formatTimeAgo(ts) {
    if (!ts) return "Never";
    var diff = Math.floor(Date.now() / 1000) - ts;
    if (diff < 60) return "Just now";
    if (diff < 3600) return Math.floor(diff / 60) + " min ago";
    if (diff < 86400) return Math.floor(diff / 3600) + " hr ago";
    return Math.floor(diff / 86400) + " days ago";
  }

  function renderSettings() {
    var children = [];

    // Account section
    var accountRows = [];
    if (state.sessionKey && state.username) {
      accountRows.push({
        type: "settings-row",
        label: "Connection",
        description: "Scrobbling as " + state.username,
        control: { type: "button", label: "Disconnect", action: "lastfm-disconnect" },
      });
      accountRows.push({
        type: "settings-row",
        label: "Profile",
        description: "last.fm/user/" + state.username,
        control: { type: "button", label: "Open", action: "lastfm-open-profile" },
      });
    } else {
      accountRows.push({
        type: "settings-row",
        label: "Connection",
        description: "Connect to scrobble your plays",
        control: { type: "button", label: "Connect", action: "lastfm-connect", variant: "accent", style: { background: "#d51007", borderColor: "#d51007" } },
      });
    }
    children.push({ type: "section", title: "Account", children: accountRows });

    // History section
    var historyRows = [];

    if (state.importing && state.importProgress) {
      historyRows.push({
        type: "progress-bar",
        value: state.importProgress.page,
        max: state.importProgress.total_pages,
        label: "Page " + state.importProgress.page + " / " + state.importProgress.total_pages
          + " — " + state.importProgress.imported + " imported, " + state.importProgress.skipped + " skipped",
      });
      historyRows.push({ type: "button", label: "Cancel Import", action: "lastfm-cancel-import" });
    } else if (state.importResult) {
      historyRows.push({
        type: "text",
        content: "<p>Import complete: " + state.importResult.imported + " imported, "
          + state.importResult.skipped + " skipped</p>",
      });
      historyRows.push({ type: "button", label: "Dismiss", action: "lastfm-dismiss-result" });
    } else {
      historyRows.push({
        type: "settings-row",
        label: "Import scrobble history",
        description: state.lastImportAt
          ? "Import new scrobbles since last sync"
          : "Import your complete listening history from Last.fm",
        control: { type: "button", label: "Import", action: "lastfm-import", disabled: !state.sessionKey },
      });
      if (state.lastImportAt) {
        historyRows.push({
          type: "settings-row",
          label: "Full re-sync",
          description: "Re-import your entire history from the beginning (duplicates are skipped)",
          control: { type: "button", label: "Re-sync", action: "lastfm-import-full", disabled: !state.sessionKey },
        });
      }
    }

    historyRows.push({
      type: "toggle",
      label: "Auto-import",
      description: "Periodically import new scrobbles in the background",
      action: "lastfm-toggle-auto-import",
      checked: state.autoImportEnabled,
      disabled: !state.sessionKey,
    });

    if (state.autoImportEnabled && state.sessionKey) {
      historyRows.push({
        type: "select",
        label: "Import interval",
        description: "How often to check for new scrobbles",
        action: "lastfm-set-interval",
        value: String(state.autoImportIntervalMins),
        options: [
          { value: "15", label: "15 minutes" },
          { value: "30", label: "30 minutes" },
          { value: "60", label: "1 hour" },
          { value: "120", label: "2 hours" },
          { value: "240", label: "4 hours" },
        ],
      });
      historyRows.push({
        type: "settings-row",
        label: "Last synced",
        description: formatTimeAgo(state.lastImportAt),
        control: { type: "text", content: "" },
      });
    }
    children.push({ type: "section", title: "History", children: historyRows });

    api.ui.setViewData("lastfm-settings", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  // ===== UI Actions =====

  api.ui.onAction("lastfm-connect", function () {
    startAuth();
  });

  api.ui.onAction("lastfm-disconnect", function () {
    disconnect();
    renderSettings();
  });

  api.ui.onAction("lastfm-open-profile", function () {
    if (state.username) {
      api.network.openUrl("https://www.last.fm/user/" + state.username);
    }
  });

  api.ui.onAction("lastfm-import", function () {
    importHistory(state.lastImportAt);
  });

  api.ui.onAction("lastfm-import-full", function () {
    importHistory(null);
  });

  api.ui.onAction("lastfm-cancel-import", function () {
    cancelImport();
  });

  api.ui.onAction("lastfm-dismiss-result", function () {
    state.importResult = null;
    renderSettings();
  });

  api.ui.onAction("lastfm-toggle-auto-import", function (data) {
    if (data && data.value) {
      startAutoImport();
    } else {
      stopAutoImport();
    }
    renderSettings();
  });

  api.ui.onAction("lastfm-set-interval", function (data) {
    if (data && data.value) {
      state.autoImportIntervalMins = parseInt(data.value, 10) || 60;
      // Restart timer with new interval
      if (state.autoImportEnabled) {
        stopAutoImport();
        startAutoImport();
      } else {
        api.storage.set("lastfm_auto_import", {
          enabled: state.autoImportEnabled,
          intervalMins: state.autoImportIntervalMins,
          lastImportAt: state.lastImportAt,
        });
      }
      renderSettings();
    }
  });

  // ===== Initialize =====

  // Load API credentials from backend
  api.informationTypes.invoke("plugin_get_lastfm_credentials").then(function (creds) {
    state.apiKey = creds[0];
    state.apiSecret = creds[1];
    _resolveApiKeyReady();

    // Migrate: clear stale cached errors/old-format data for all lastfm info types
    return api.storage.get("cache_migrated_v3").then(function (done) {
      if (!done) {
        console.log("[lastfm] Running cache_migrated_v3 migration");
        var types = [
          "album_track_popularity", "album_wiki",
          "artist_bio", "artist_stats", "artist_top_tracks", "similar_artists",
          "track_info", "track_tags", "similar_tracks",
        ];
        var deletes = types.map(function (t) {
          return api.informationTypes.invoke("info_delete_values_for_type", { typeId: t }).catch(function () {});
        });
        return Promise.all(deletes).then(function () {
          return api.storage.set("cache_migrated_v3", true);
        });
      }
    });
  }).then(function () {
    // Restore session
    return api.storage.get("lastfm_session");
  }).then(function (session) {
    if (session && session.sessionKey && session.username) {
      state.sessionKey = session.sessionKey;
      state.username = session.username;
    }

    // Restore auto-import settings
    return api.storage.get("lastfm_auto_import");
  }).then(function (config) {
    if (config) {
      state.autoImportIntervalMins = config.intervalMins || 60;
      state.lastImportAt = config.lastImportAt || null;
      if (config.enabled && state.sessionKey) {
        startAutoImport();
      }
    }
    renderSettings();
  }).catch(function (err) {
    console.error("[lastfm] init error:", err);
    _resolveApiKeyReady(); // Unblock handlers — they'll fail gracefully via lastfmGet guard
    renderSettings();
  });
}

function deactivate() {
  // Auto-import timer is cleaned up by the plugin system unsubscribers
}

return { activate: activate, deactivate: deactivate };
