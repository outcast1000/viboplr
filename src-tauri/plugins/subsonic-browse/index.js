// Subsonic Browse — a live, multi-server discovery layer.
//
// Unlike a core `subsonic` collection (which indexes a single server's catalog
// into the local library), this plugin keeps servers OUT of the library: it
// searches all registered servers in parallel, merges + de-duplicates the
// results, and plays/downloads on demand. Tracks carry a custom `xsonic://`
// scheme so the plugin's stream/download resolvers fire for them (and never
// collide with core's `subsonic://` tracks).
//
// Three roles, all wired to existing plugin surfaces:
//   - Discovery  -> own sidebar view (parallel search3 across servers)
//   - Streaming  -> onResolveStreamByUri("xsonic") + metadata fallback resolver
//   - Download   -> download provider (by-uri + interactive search/resolve)

function activate(api) {
  var COMMON = "&v=1.16.1&c=viboplr&f=json";
  var SCHEME = "xsonic";                 // custom track scheme (distinct from core's subsonic://)
  var PROVIDER = "subsonic-browse";      // stream/download provider id (matches manifest)
  var VIEW = "subsonic-browse";          // sidebar view id
  var SEARCH_TIMEOUT_MS = 8000;          // per-server budget; one slow server can't stall the rest
  var PER_SERVER_LIMIT = 40;

  // ---- in-memory state --------------------------------------------------
  var state = {
    servers: [],            // [{id,name,url,username,password,authMethod}]
    form: { name: "", url: "", username: "", password: "" },
    editingId: null,        // server id being edited in the Manage tab (null = not editing)
    addingNew: false,       // in-tab add form open (Manage tab, no server selected)
    confirmRemoveId: null,  // server id pending a remove confirmation (null = no confirm shown)
    adding: false,
    addStatus: "",
    addError: false,
    query: "",
    searching: false,
    results: [],            // merged songs (ordered); each has .alternates[]
    albumResults: [],       // merged albums; each has .alternates[]
    artistResults: [],      // merged artists; each has .alternates[]
    activeTab: "tracks",    // "tracks" | "albums" | "artists"
    view: "results",        // "results" | "album" | "artist" | "servers" | "about"
    nav: [],                // back-stack of prior view states
    detail: null,           // current detail: { kind, server, title, subtitle, coverId, loading, error, tracks?, albums? }
    detailTracks: [],       // PluginTracks shown in album detail (for play-by-index)
    statusLine: "",
    downServers: {},        // serverId -> true (unreachable this session)
    alternates: {},         // "serverId/trackId" -> [{serverId,trackId,serverName}] for failover
    metaCache: {},          // "serverId/trackId" -> {title,artist,album,trackNumber,coverUrl} for downloads
  };

  // ---- MD5 (blueimp / Paul Johnston, public domain) ---------------------
  // Subsonic token auth = md5(password + salt). The WebView's crypto.subtle has
  // no MD5, so we bundle a compact, well-known implementation.
  function md5(str) { return rstr2hex(rstr_md5(str2rstr_utf8(str))); }
  function rstr_md5(s) { return binl2rstr(binl_md5(rstr2binl(s), s.length * 8)); }
  function rstr2hex(input) {
    var hex = "0123456789abcdef", out = "", x;
    for (var i = 0; i < input.length; i++) {
      x = input.charCodeAt(i);
      out += hex.charAt((x >>> 4) & 0x0f) + hex.charAt(x & 0x0f);
    }
    return out;
  }
  function str2rstr_utf8(input) { return unescape(encodeURIComponent(input)); }
  function rstr2binl(input) {
    var output = [];
    for (var i = 0; i < input.length * 8; i += 8) {
      output[i >> 5] |= (input.charCodeAt(i / 8) & 0xff) << (i % 32);
    }
    return output;
  }
  function binl2rstr(input) {
    var output = "";
    for (var i = 0; i < input.length * 32; i += 8) {
      output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xff);
    }
    return output;
  }
  function binl_md5(x, len) {
    x[len >> 5] |= 0x80 << (len % 32);
    x[(((len + 64) >>> 9) << 4) + 14] = len;
    var a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (var i = 0; i < x.length; i += 16) {
      var olda = a, oldb = b, oldc = c, oldd = d;
      a = md5_ff(a, b, c, d, x[i], 7, -680876936);
      d = md5_ff(d, a, b, c, x[i + 1], 12, -389564586);
      c = md5_ff(c, d, a, b, x[i + 2], 17, 606105819);
      b = md5_ff(b, c, d, a, x[i + 3], 22, -1044525330);
      a = md5_ff(a, b, c, d, x[i + 4], 7, -176418897);
      d = md5_ff(d, a, b, c, x[i + 5], 12, 1200080426);
      c = md5_ff(c, d, a, b, x[i + 6], 17, -1473231341);
      b = md5_ff(b, c, d, a, x[i + 7], 22, -45705983);
      a = md5_ff(a, b, c, d, x[i + 8], 7, 1770035416);
      d = md5_ff(d, a, b, c, x[i + 9], 12, -1958414417);
      c = md5_ff(c, d, a, b, x[i + 10], 17, -42063);
      b = md5_ff(b, c, d, a, x[i + 11], 22, -1990404162);
      a = md5_ff(a, b, c, d, x[i + 12], 7, 1804603682);
      d = md5_ff(d, a, b, c, x[i + 13], 12, -40341101);
      c = md5_ff(c, d, a, b, x[i + 14], 17, -1502002290);
      b = md5_ff(b, c, d, a, x[i + 15], 22, 1236535329);
      a = md5_gg(a, b, c, d, x[i + 1], 5, -165796510);
      d = md5_gg(d, a, b, c, x[i + 6], 9, -1069501632);
      c = md5_gg(c, d, a, b, x[i + 11], 14, 643717713);
      b = md5_gg(b, c, d, a, x[i], 20, -373897302);
      a = md5_gg(a, b, c, d, x[i + 5], 5, -701558691);
      d = md5_gg(d, a, b, c, x[i + 10], 9, 38016083);
      c = md5_gg(c, d, a, b, x[i + 15], 14, -660478335);
      b = md5_gg(b, c, d, a, x[i + 4], 20, -405537848);
      a = md5_gg(a, b, c, d, x[i + 9], 5, 568446438);
      d = md5_gg(d, a, b, c, x[i + 14], 9, -1019803690);
      c = md5_gg(c, d, a, b, x[i + 3], 14, -187363961);
      b = md5_gg(b, c, d, a, x[i + 8], 20, 1163531501);
      a = md5_gg(a, b, c, d, x[i + 13], 5, -1444681467);
      d = md5_gg(d, a, b, c, x[i + 2], 9, -51403784);
      c = md5_gg(c, d, a, b, x[i + 7], 14, 1735328473);
      b = md5_gg(b, c, d, a, x[i + 12], 20, -1926607734);
      a = md5_hh(a, b, c, d, x[i + 5], 4, -378558);
      d = md5_hh(d, a, b, c, x[i + 8], 11, -2022574463);
      c = md5_hh(c, d, a, b, x[i + 11], 16, 1839030562);
      b = md5_hh(b, c, d, a, x[i + 14], 23, -35309556);
      a = md5_hh(a, b, c, d, x[i + 1], 4, -1530992060);
      d = md5_hh(d, a, b, c, x[i + 4], 11, 1272893353);
      c = md5_hh(c, d, a, b, x[i + 7], 16, -155497632);
      b = md5_hh(b, c, d, a, x[i + 10], 23, -1094730640);
      a = md5_hh(a, b, c, d, x[i + 13], 4, 681279174);
      d = md5_hh(d, a, b, c, x[i], 11, -358537222);
      c = md5_hh(c, d, a, b, x[i + 3], 16, -722521979);
      b = md5_hh(b, c, d, a, x[i + 6], 23, 76029189);
      a = md5_hh(a, b, c, d, x[i + 9], 4, -640364487);
      d = md5_hh(d, a, b, c, x[i + 12], 11, -421815835);
      c = md5_hh(c, d, a, b, x[i + 15], 16, 530742520);
      b = md5_hh(b, c, d, a, x[i + 2], 23, -995338651);
      a = md5_ii(a, b, c, d, x[i], 6, -198630844);
      d = md5_ii(d, a, b, c, x[i + 7], 10, 1126891415);
      c = md5_ii(c, d, a, b, x[i + 14], 15, -1416354905);
      b = md5_ii(b, c, d, a, x[i + 5], 21, -57434055);
      a = md5_ii(a, b, c, d, x[i + 12], 6, 1700485571);
      d = md5_ii(d, a, b, c, x[i + 3], 10, -1894986606);
      c = md5_ii(c, d, a, b, x[i + 10], 15, -1051523);
      b = md5_ii(b, c, d, a, x[i + 1], 21, -2054922799);
      a = md5_ii(a, b, c, d, x[i + 8], 6, 1873313359);
      d = md5_ii(d, a, b, c, x[i + 15], 10, -30611744);
      c = md5_ii(c, d, a, b, x[i + 6], 15, -1560198380);
      b = md5_ii(b, c, d, a, x[i + 13], 21, 1309151649);
      a = md5_ii(a, b, c, d, x[i + 4], 6, -145523070);
      d = md5_ii(d, a, b, c, x[i + 11], 10, -1120210379);
      c = md5_ii(c, d, a, b, x[i + 2], 15, 718787259);
      b = md5_ii(b, c, d, a, x[i + 9], 21, -343485551);
      a = safe_add(a, olda); b = safe_add(b, oldb);
      c = safe_add(c, oldc); d = safe_add(d, oldd);
    }
    return [a, b, c, d];
  }
  function md5_cmn(q, a, b, x, s, t) { return safe_add(bit_rol(safe_add(safe_add(a, q), safe_add(x, t)), s), b); }
  function md5_ff(a, b, c, d, x, s, t) { return md5_cmn((b & c) | (~b & d), a, b, x, s, t); }
  function md5_gg(a, b, c, d, x, s, t) { return md5_cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function md5_hh(a, b, c, d, x, s, t) { return md5_cmn(b ^ c ^ d, a, b, x, s, t); }
  function md5_ii(a, b, c, d, x, s, t) { return md5_cmn(c ^ (b | ~d), a, b, x, s, t); }
  function safe_add(x, y) {
    var lsw = (x & 0xffff) + (y & 0xffff);
    var msw = (x >> 16) + (y >> 16) + (lsw >> 16);
    return (msw << 16) | (lsw & 0xffff);
  }
  function bit_rol(num, cnt) { return (num << cnt) | (num >>> (32 - cnt)); }

  // ---- small helpers ----------------------------------------------------
  function enc(s) { return encodeURIComponent(s == null ? "" : String(s)); }
  function trimUrl(u) { return String(u || "").replace(/\/+$/, ""); }
  function genId() { return "s" + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
  function genSalt() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
  function hostOf(u) {
    var m = String(u || "").replace(/^https?:\/\//, "").split("/")[0];
    return m || String(u || "");
  }
  function parseId(id) {
    if (!id) return null;
    var i = String(id).indexOf("/");
    if (i < 0) return null;
    return { serverId: id.slice(0, i), trackId: id.slice(i + 1) };
  }
  function findServer(id) {
    for (var i = 0; i < state.servers.length; i++) if (state.servers[i].id === id) return state.servers[i];
    return null;
  }
  function fmtDur(s) {
    s = Math.round(s || 0);
    var m = Math.floor(s / 60), ss = s % 60;
    return m + ":" + (ss < 10 ? "0" : "") + ss;
  }
  // Mirror the backend's strip_diacritics(unicode_lower(...)) so dedup/matching
  // lines up with the rest of the app (Björk == Bjork, Γιάννης == ΓΙΑΝΝΗΣ, etc.).
  // \p{M} strips ALL combining marks, like the backend — not just U+0300–U+036F.
  function norm(s) {
    if (!s) return "";
    return String(s).normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  }
  function songKey(title, artist) { return norm(artist) + "" + norm(title); }

  // ---- Subsonic API -----------------------------------------------------
  function authParams(server) {
    if (server.authMethod === "plaintext") {
      return "u=" + enc(server.username) + "&p=" + enc(server.password) + COMMON;
    }
    var salt = genSalt();
    return "u=" + enc(server.username) + "&t=" + md5(server.password + salt) + "&s=" + salt + COMMON;
  }
  function restUrl(server, endpoint, extra) {
    return trimUrl(server.url) + "/rest/" + endpoint + "?" + authParams(server) + (extra ? "&" + extra : "");
  }
  function coverUrl(server, coverId) {
    if (!server || !coverId) return null;
    return restUrl(server, "getCoverArt.view", "id=" + enc(coverId) + "&size=300");
  }
  function streamUrl(server, trackId) { return restUrl(server, "stream.view", "id=" + enc(trackId)); }
  function downloadUrl(server, trackId) { return restUrl(server, "download.view", "id=" + enc(trackId)); }

  async function subsonicGet(server, endpoint, extra) {
    var resp = await api.network.fetch(restUrl(server, endpoint, extra));
    var data = await resp.json();
    var r = data && data["subsonic-response"];
    if (!r || r.status !== "ok") {
      throw new Error((r && r.error && r.error.message) || "Subsonic error");
    }
    return r;
  }

  function pingWith(draft) { return subsonicGet(draft, "ping.view"); }

  // Try token auth, fall back to plaintext (mirrors the native SubsonicClient).
  async function detectAuth(draft) {
    try {
      await pingWith({ url: draft.url, username: draft.username, password: draft.password, authMethod: "token" });
      return "token";
    } catch (e) {
      console.error("subsonic-browse: token auth failed for " + draft.url + ", trying plaintext:", e);
    }
    await pingWith({ url: draft.url, username: draft.username, password: draft.password, authMethod: "plaintext" });
    return "plaintext";
  }

  function mapSong(server, s) {
    var song = {
      serverId: server.id,
      serverName: server.name,
      trackId: s.id,
      title: s.title || "Unknown",
      artist: s.artist || null,
      album: s.album || null,
      duration: typeof s.duration === "number" ? s.duration : null,
      track: typeof s.track === "number" ? s.track : null,
      coverId: s.coverArt || s.id,
    };
    // Cache metadata for every surfaced song so a later download-by-uri (e.g.
    // right-click → Download on a queued track) carries full tags + cover.
    state.metaCache[server.id + "/" + s.id] = {
      title: song.title, artist: song.artist, album: song.album,
      trackNumber: song.track, coverUrl: coverUrl(server, song.coverId),
    };
    return song;
  }

  function mapAlbum(server, a) {
    return {
      serverId: server.id,
      serverName: server.name,
      albumId: a.id,
      title: a.name || a.title || "Unknown",
      artist: a.artist || null,
      year: typeof a.year === "number" ? a.year : null,
      coverId: a.coverArt || a.id,
      songCount: typeof a.songCount === "number" ? a.songCount : null,
    };
  }

  function mapArtist(server, ar) {
    return {
      serverId: server.id,
      serverName: server.name,
      artistId: ar.id,
      name: ar.name || "Unknown",
      albumCount: typeof ar.albumCount === "number" ? ar.albumCount : null,
      coverId: ar.coverArt || ar.id,
    };
  }

  // Authoritative metadata lookup for a single track — covers cold-cache tracks
  // (e.g. a queue restored after restart) that were never surfaced this session.
  async function fetchSongMeta(server, trackId) {
    try {
      var r = await subsonicGet(server, "getSong.view", "id=" + enc(trackId));
      var s = r.song;
      if (!s) return null;
      return {
        title: s.title, artist: s.artist, album: s.album,
        trackNumber: typeof s.track === "number" ? s.track : undefined,
        year: typeof s.year === "number" ? s.year : undefined,
        genre: s.genre,
        coverUrl: coverUrl(server, s.coverArt || s.id),
      };
    } catch (e) {
      console.error("subsonic-browse: getSong failed:", e);
      return null;
    }
  }

  // Never rejects: resolves to a tagged result so one failure can't sink the
  // whole parallel batch. Marks the server up/down for this session.
  function searchServerSafe(server, query, limit) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        state.downServers[server.id] = true;
        resolve({ server: server, ok: false, songs: [], albums: [], artists: [], error: "timed out" });
      }, SEARCH_TIMEOUT_MS);
      subsonicGet(server, "search3.view", "query=" + enc(query) + "&songCount=" + limit + "&albumCount=" + limit + "&artistCount=" + limit).then(
        function (r) {
          if (done) return;
          done = true; clearTimeout(timer);
          delete state.downServers[server.id];
          var sr = r.searchResult3 || {};
          resolve({
            server: server, ok: true,
            songs: (sr.song || []).map(function (s) { return mapSong(server, s); }),
            albums: (sr.album || []).map(function (a) { return mapAlbum(server, a); }),
            artists: (sr.artist || []).map(function (ar) { return mapArtist(server, ar); }),
          });
        },
        function (err) {
          if (done) return;
          done = true; clearTimeout(timer);
          state.downServers[server.id] = true;
          console.error("subsonic-browse: search failed on " + server.name + ":", err);
          resolve({ server: server, ok: false, songs: [], albums: [], artists: [], error: String((err && err.message) || err) });
        }
      );
    });
  }

  // Merge entities of one kind across servers: the same entity on N servers
  // collapses into one item carrying all copies as `alternates` (play-time
  // failover + an "N servers" affordance). `idField` is the per-kind id key
  // (trackId / albumId / artistId).
  function mergeByKey(list, keyOf, idField) {
    var merged = [], byKey = {};
    list.forEach(function (item) {
      var key = keyOf(item);
      var alt = { serverId: item.serverId, serverName: item.serverName };
      alt[idField] = item[idField];
      if (typeof item.songCount === "number") alt.songCount = item.songCount;    // per-server album track count
      if (typeof item.albumCount === "number") alt.albumCount = item.albumCount; // per-server artist album count
      if (byKey[key] != null) { merged[byKey[key]].alternates.push(alt); return; }
      item.alternates = [alt];
      byKey[key] = merged.length;
      merged.push(item);
    });
    return merged;
  }

  // First non-down alternate, else the first (so we always return something).
  function healthyAlt(alternates) {
    for (var i = 0; i < alternates.length; i++) {
      if (!state.downServers[alternates[i].serverId]) return alternates[i];
    }
    return alternates[0];
  }

  // Run a query across every server and merge each entity kind independently.
  async function searchAll(query, limit) {
    var settled = await Promise.all(state.servers.map(function (s) { return searchServerSafe(s, query, limit); }));
    var ok = 0, fail = 0, failNames = [], songs = [], albums = [], artists = [];
    settled.forEach(function (res) {
      if (res.ok) ok++; else { fail++; failNames.push(res.server.name); }
      songs = songs.concat(res.songs || []);
      albums = albums.concat(res.albums || []);
      artists = artists.concat(res.artists || []);
    });
    return {
      songs: mergeByKey(songs, function (s) { return songKey(s.title, s.artist); }, "trackId"),
      albums: mergeByKey(albums, function (a) { return norm(a.artist) + "" + norm(a.title); }, "albumId"),
      artists: mergeByKey(artists, function (ar) { return norm(ar.name); }, "artistId"),
      ok: ok, fail: fail, failNames: failNames,
    };
  }

  // Relevance rank on norm()-folded strings: case/diacritic-insensitive, so an
  // unaccented query still ranks accented titles (and all-caps Greek, which by
  // convention drops the tonos) as exact/prefix/substring matches.
  function rank(title, q) {
    var t = norm(title);
    if (t === q) return 0;
    if (t.indexOf(q) === 0) return 1;
    if (t.indexOf(q) >= 0) return 2;
    return 3;
  }

  async function runSearch(query) {
    state.searching = true;
    state.query = query;
    state.view = "results";
    state.nav = [];
    renderBrowse();
    var res = await searchAll(query, PER_SERVER_LIMIT);
    var q = norm(query);
    function sortByRank(list, titleOf) {
      list.sort(function (a, b) {
        var d = rank(titleOf(a), q) - rank(titleOf(b), q);
        return d !== 0 ? d : titleOf(a).localeCompare(titleOf(b));
      });
    }
    sortByRank(res.songs, function (s) { return s.title || ""; });
    sortByRank(res.albums, function (a) { return a.title || ""; });
    sortByRank(res.artists, function (ar) { return ar.name || ""; });
    // Index every song copy -> the full alternates list, so the stream resolver
    // can fail over no matter which server's id ends up encoded in the queue path.
    state.alternates = {};
    res.songs.forEach(function (song) {
      song.alternates.forEach(function (alt) {
        state.alternates[alt.serverId + "/" + alt.trackId] = song.alternates;
      });
    });
    state.results = res.songs;
    state.albumResults = res.albums;
    state.artistResults = res.artists;
    state.statusLine = buildStatus(res, res.songs.length + res.albums.length + res.artists.length);
    state.searching = false;
    renderBrowse();
  }

  function buildStatus(res, count) {
    var parts = [count + " result" + (count === 1 ? "" : "s")];
    parts.push(res.ok + " server" + (res.ok === 1 ? "" : "s") + " responded");
    if (res.fail > 0) parts.push(res.fail + " unreachable (" + res.failNames.join(", ") + ")");
    return parts.join("  ·  ");
  }

  function primaryOf(song) { return song.alternates[0]; }

  function toPluginTrack(song) {
    var p = primaryOf(song);
    var server = findServer(p.serverId);
    return {
      path: SCHEME + "://" + p.serverId + "/" + p.trackId,
      title: song.title,
      artist_name: song.artist,
      album_title: song.album,
      duration_secs: song.duration,
      track_number: song.track,
      image_url: coverUrl(server, song.coverId),
    };
  }

  // ---- Browse view ------------------------------------------------------
  function rowFromSong(song) {
    var p = primaryOf(song);
    var server = findServer(p.serverId);
    var src = song.alternates.length > 1 ? song.alternates.length + " servers" : p.serverName;
    var sub = (song.artist || "") + (src ? "  ·  " + src : "");
    return {
      id: p.serverId + "/" + p.trackId,
      title: song.title,
      subtitle: sub,
      album: song.album || "",
      imageUrl: coverUrl(server, song.coverId),
      duration: song.duration != null ? fmtDur(song.duration) : "",
      action: "play-song",
    };
  }

  // "N <unit>s" when the servers holding this entity agree on a per-server count;
  // "⚠ A–B <unit>s" when they differ (likely divergent tagging/editions).
  function countLabel(alternates, field, unit) {
    var counts = [];
    for (var i = 0; i < alternates.length; i++) {
      var c = alternates[i][field];
      if (typeof c === "number") counts.push(c);
    }
    if (!counts.length) return null;
    var min = Math.min.apply(null, counts), max = Math.max.apply(null, counts);
    if (min === max) return min + " " + unit + (min === 1 ? "" : "s");
    return "⚠ " + min + "–" + max + " " + unit + "s";
  }

  function cardFromAlbum(album) {
    var p = album.alternates[0];
    var server = findServer(p.serverId);
    var parts = [];
    if (album.artist) parts.push(album.artist);
    if (album.alternates.length > 1) parts.push(album.alternates.length + " servers");
    var cl = countLabel(album.alternates, "songCount", "track");
    if (cl) parts.push(cl);
    return {
      id: p.serverId + "/" + p.albumId,
      title: album.title,
      subtitle: parts.join("  ·  "),
      imageUrl: coverUrl(server, album.coverId),
      action: "open-album",
      contextMenuActions: [{ id: "play-playlist", label: "Play" }],
      targetKind: "album",
    };
  }

  function cardFromArtist(artist) {
    var p = artist.alternates[0];
    var server = findServer(p.serverId);
    var parts = [];
    if (artist.alternates.length > 1) parts.push(artist.alternates.length + " servers");
    var cl = countLabel(artist.alternates, "albumCount", "album");
    if (cl) parts.push(cl);
    return {
      id: p.serverId + "/" + p.artistId,
      title: artist.name,
      subtitle: parts.length ? parts.join("  ·  ") : undefined,
      imageUrl: coverUrl(server, artist.coverId),
      action: "open-artist",
      targetKind: "artist",
    };
  }

  // Resolve a card id ("serverId/entityId") back to its merged entity.
  function findAlbumById(id) {
    for (var i = 0; i < state.albumResults.length; i++) {
      var a = state.albumResults[i];
      for (var j = 0; j < a.alternates.length; j++) {
        if (a.alternates[j].serverId + "/" + a.alternates[j].albumId === id) return a;
      }
    }
    return null;
  }
  function findArtistById(id) {
    for (var i = 0; i < state.artistResults.length; i++) {
      var ar = state.artistResults[i];
      for (var j = 0; j < ar.alternates.length; j++) {
        if (ar.alternates[j].serverId + "/" + ar.alternates[j].artistId === id) return ar;
      }
    }
    return null;
  }

  // Results surface: search box + tabs (Tracks/Albums/Artists) + active body.
  function renderResults() {
    var children = [];
    children.push(sectionTabs("search"));
    children.push({
      type: "search-input",
      placeholder: "Search all servers…",
      action: "do-search",
      submitOnly: true,
      buttonLabel: "Search",
      value: state.query,
    });
    if (state.servers.length === 0) {
      children.push({ type: "spacer" });
      children.push({ type: "text", content: "No servers connected yet. Add one from the Manage tab to search, stream, and download across servers." });
      children.push({ type: "spacer" });
      children.push({ type: "button", label: "+ Add a server", action: "switch-section", data: { tabId: "manage" }, className: "ds-btn ds-btn--primary", style: { alignSelf: "flex-start" } });
    } else if (state.searching) {
      children.push({ type: "spacer" });
      children.push({ type: "loading", message: "Searching " + state.servers.length + " server" + (state.servers.length > 1 ? "s" : "") + "…" });
    } else if (state.query) {
      // search-input + tabs lead the layout so the renderer hoists both above
      // the scroll area; everything after scrolls.
      children.push({
        type: "tabs",
        activeTab: state.activeTab,
        action: "switch-tab",
        tabs: [
          { id: "tracks", label: "Tracks", count: state.results.length },
          { id: "albums", label: "Albums", count: state.albumResults.length },
          { id: "artists", label: "Artists", count: state.artistResults.length },
        ],
      });
      children.push({ type: "spacer" });
      if (state.statusLine) children.push({ type: "text", content: state.statusLine });
      if (state.activeTab === "albums") {
        if (state.albumResults.length === 0) children.push({ type: "text", content: "No albums found." });
        else children.push({ type: "card-grid", items: state.albumResults.map(cardFromAlbum) });
      } else if (state.activeTab === "artists") {
        if (state.artistResults.length === 0) children.push({ type: "text", content: "No artists found." });
        else children.push({ type: "card-grid", items: state.artistResults.map(cardFromArtist) });
      } else {
        if (state.results.length === 0) children.push({ type: "text", content: "No tracks found." });
        else children.push({ type: "track-row-list", showHeader: true, items: state.results.map(rowFromSong) });
      }
    } else {
      children.push({ type: "spacer" });
      children.push({ type: "text", content: state.servers.length + " server" + (state.servers.length > 1 ? "s" : "") + " connected. Type a query to search across all of them at once." });
    }
    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: state.query ? "q:" + state.query + ":" + state.activeTab : "home" });
  }

  // Top-level Search / Manage tab row, shown at the root of both sections.
  function sectionTabs(active) {
    return {
      type: "tabs",
      activeTab: active,
      action: "switch-section",
      tabs: [{ id: "search", label: "Search" }, { id: "manage", label: "Manage" }, { id: "about", label: "About" }],
    };
  }

  function renderBrowse() {
    if (state.view === "album") return renderAlbumDetail();
    if (state.view === "artist") return renderArtistDetail();
    if (state.view === "servers") return renderServersManage();
    if (state.view === "about") return renderAbout();
    return renderResults();
  }

  // ---- Detail sub-views (album / artist) --------------------------------
  async function getAlbumTracks(server, albumId) {
    var r = await subsonicGet(server, "getAlbum.view", "id=" + enc(albumId));
    var a = r.album || {};
    return { album: a, songs: (a.song || []).map(function (s) { return mapSong(server, s); }) };
  }
  async function getArtistAlbums(server, artistId) {
    var r = await subsonicGet(server, "getArtist.view", "id=" + enc(artistId));
    var ar = r.artist || {};
    return { artist: ar, albums: (ar.album || []).map(function (al) { return mapAlbum(server, al); }) };
  }

  function songToPluginTrack(s) {
    var server = findServer(s.serverId);
    return {
      path: SCHEME + "://" + s.serverId + "/" + s.trackId,
      title: s.title,
      artist_name: s.artist,
      album_title: s.album,
      duration_secs: s.duration,
      track_number: s.track,
      image_url: coverUrl(server, s.coverId),
    };
  }
  // Album/artist-detail tracks come from a single server (one getAlbum call), so
  // each gets a single-server alternate entry for the stream resolver.
  function indexSingleServerTracks(songs) {
    songs.forEach(function (s) {
      state.alternates[s.serverId + "/" + s.trackId] = [{ serverId: s.serverId, trackId: s.trackId, serverName: s.serverName }];
    });
  }

  // Resolve an album card id to a fetch/play ref: prefer the merged search entity
  // (cross-server failover), then the open artist detail's albums, then the id
  // itself (always "serverId/albumId").
  function findAlbumRefFromDetail(id) {
    if (!state.detail || state.detail.kind !== "artist" || !state.detail.albums) return null;
    for (var i = 0; i < state.detail.albums.length; i++) {
      var al = state.detail.albums[i];
      if (al.serverId + "/" + al.albumId === id) return { serverId: al.serverId, albumId: al.albumId, title: al.title, artist: al.artist, coverId: al.coverId };
    }
    return null;
  }
  function resolveAlbumRef(id) {
    var album = findAlbumById(id);
    if (album) { var alt = healthyAlt(album.alternates); return { serverId: alt.serverId, albumId: alt.albumId, title: album.title, artist: album.artist, coverId: album.coverId }; }
    var fromDetail = findAlbumRefFromDetail(id);
    if (fromDetail) return fromDetail;
    var p = parseId(id);
    return p ? { serverId: p.serverId, albumId: p.trackId } : null;
  }

  function pushNav() {
    state.nav.push({ view: state.view, detail: state.detail, activeTab: state.activeTab });
  }
  function goBack() {
    var prev = state.nav.pop();
    if (prev) { state.view = prev.view; state.detail = prev.detail; state.activeTab = prev.activeTab; }
    else { state.view = "results"; state.detail = null; }
    renderBrowse();
  }

  function openAlbum(id) {
    var ref = resolveAlbumRef(id);
    if (!ref) return;
    var server = findServer(ref.serverId);
    if (!server) return;
    pushNav();
    state.view = "album";
    state.detail = { kind: "album", server: server, title: ref.title || "Album", subtitle: ref.artist || "", coverId: ref.coverId || null, loading: true, error: null, songs: [] };
    state.detailTracks = [];
    renderBrowse();
    getAlbumTracks(server, ref.albumId).then(
      function (out) {
        if (state.view !== "album" || !state.detail) return;
        state.detail.loading = false;
        state.detail.title = out.album.name || state.detail.title;
        state.detail.subtitle = out.album.artist || state.detail.subtitle;
        state.detail.coverId = out.album.coverArt || state.detail.coverId;
        state.detail.songs = out.songs;
        state.detailTracks = out.songs.map(songToPluginTrack);
        indexSingleServerTracks(out.songs);
        renderBrowse();
      },
      function (e) {
        console.error("subsonic-browse: getAlbum failed:", e);
        if (state.view === "album" && state.detail) { state.detail.loading = false; state.detail.error = "Couldn't load this album."; renderBrowse(); }
      }
    );
  }

  function openArtist(id) {
    var artist = findArtistById(id);
    var ref;
    if (artist) { var alt = healthyAlt(artist.alternates); ref = { serverId: alt.serverId, artistId: alt.artistId, name: artist.name, coverId: artist.coverId }; }
    else { var p = parseId(id); ref = p ? { serverId: p.serverId, artistId: p.trackId } : null; }
    if (!ref) return;
    var server = findServer(ref.serverId);
    if (!server) return;
    pushNav();
    state.view = "artist";
    state.detail = { kind: "artist", server: server, title: ref.name || "Artist", coverId: ref.coverId || null, loading: true, error: null, albums: [] };
    renderBrowse();
    getArtistAlbums(server, ref.artistId).then(
      function (out) {
        if (state.view !== "artist" || !state.detail) return;
        state.detail.loading = false;
        state.detail.title = out.artist.name || state.detail.title;
        state.detail.coverId = out.artist.coverArt || state.detail.coverId;
        // Give each album a single-server alternate so its card opens/plays.
        out.albums.forEach(function (al) { al.alternates = [{ serverId: al.serverId, albumId: al.albumId, serverName: al.serverName, songCount: al.songCount }]; });
        state.detail.albums = out.albums;
        renderBrowse();
      },
      function (e) {
        console.error("subsonic-browse: getArtist failed:", e);
        if (state.view === "artist" && state.detail) { state.detail.loading = false; state.detail.error = "Couldn't load this artist."; renderBrowse(); }
      }
    );
  }

  function renderAlbumDetail() {
    var d = state.detail || {};
    var server = d.server;
    var cover = coverUrl(server, d.coverId);
    var children = [{
      type: "detail-header",
      title: d.title || "Album",
      subtitle: d.subtitle || "",
      imageUrl: cover,
      bgImages: cover ? [cover] : [],
      artShape: "square",
      backAction: "back",
      playAction: "play-detail-all",
    }];
    children.push({ type: "spacer" });
    if (d.loading) children.push({ type: "loading", message: "Loading album…" });
    else if (d.error) children.push({ type: "text", content: d.error });
    else {
      var songs = d.songs || [];
      if (songs.length === 0) children.push({ type: "text", content: "No tracks." });
      else children.push({
        type: "track-row-list", showHeader: true, numbered: true,
        items: songs.map(function (s) {
          return {
            id: s.serverId + "/" + s.trackId,
            title: s.title,
            subtitle: s.artist || "",
            album: s.album || "",
            imageUrl: coverUrl(server, s.coverId),
            duration: s.duration != null ? fmtDur(s.duration) : "",
            action: "play-album-track",
          };
        }),
      });
    }
    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: "album:" + (d.title || "") });
  }

  function renderArtistDetail() {
    var d = state.detail || {};
    var server = d.server;
    var cover = coverUrl(server, d.coverId);
    var children = [{
      type: "detail-header",
      title: d.title || "Artist",
      imageUrl: cover,
      bgImages: cover ? [cover] : [],
      artShape: "circle",
      backAction: "back",
    }];
    children.push({ type: "spacer" });
    if (d.loading) children.push({ type: "loading", message: "Loading artist…" });
    else if (d.error) children.push({ type: "text", content: d.error });
    else {
      var albums = d.albums || [];
      if (albums.length === 0) children.push({ type: "text", content: "No albums." });
      else children.push({ type: "card-grid", items: albums.map(cardFromAlbum) });
    }
    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: "artist:" + (d.title || "") });
  }

  // Fetch an album's tracks on demand and play them (card play button).
  function playAlbumById(id) {
    var ref = resolveAlbumRef(id);
    if (!ref) return;
    var server = findServer(ref.serverId);
    if (!server) return;
    getAlbumTracks(server, ref.albumId).then(
      function (out) {
        var tracks = out.songs.map(songToPluginTrack);
        if (tracks.length === 0) return;
        indexSingleServerTracks(out.songs);
        api.playback.playTracks(tracks, 0, {
          name: out.album.name || ref.title || "Album",
          coverUrl: coverUrl(server, out.album.coverArt || ref.coverId),
          source: "playlist",
        });
      },
      function (e) { console.error("subsonic-browse: play album failed:", e); }
    );
  }

  // ---- Manage tab: server list <-> in-tab add/edit form -----------------
  // Everything (list, add, edit, remove-confirm) renders under the Manage tab;
  // the Search/Manage/About tabs stay visible the whole time.
  function renderServersManage() {
    var editing = state.editingId ? findServer(state.editingId) : null;
    var formMode = !!editing || state.addingNew;

    var children = [sectionTabs("manage")];

    if (formMode) {
      children.push({
        type: "toolbar",
        title: editing ? ("Edit · " + editing.name) : "Add a server",
        buttons: [{ label: "‹ Servers", action: "back-to-list", variant: "secondary" }],
        status: state.addStatus || undefined,
        statusVariant: state.addError ? "error" : "success",
      });
      children.push({ type: "spacer" });
      children.push({ type: "section", title: "Connection", children: [
        { type: "settings-row", label: "Name", description: "A label for this server (optional)", control: { type: "text-input", placeholder: "My server", action: "form-name", value: state.form.name } },
        { type: "settings-row", label: "Server URL", description: "e.g. https://music.example.com", control: { type: "text-input", placeholder: "https://…", action: "form-url", value: state.form.url } },
        { type: "settings-row", label: "Username", control: { type: "text-input", placeholder: "user", action: "form-username", value: state.form.username } },
        { type: "settings-row", label: "Password", description: editing ? "Leave blank to keep the current password" : "Stored locally; sent to the server over your connection", control: { type: "text-input", placeholder: editing ? "•••••• (unchanged)" : "password", action: "form-password", value: state.form.password } },
      ] });
      children.push({ type: "spacer" });
      var btns = [{ type: "button", label: state.adding ? (editing ? "Saving…" : "Testing…") : (editing ? "Save changes" : "Test & Add"), action: "save-server", className: "ds-btn ds-btn--primary", disabled: state.adding, style: { alignSelf: "flex-start" } }];
      if (editing) btns.push({ type: "button", label: "Remove server", action: "ask-remove", className: "ds-btn ds-btn--danger", disabled: state.adding, data: { id: editing.id }, style: { alignSelf: "flex-start" } });
      children.push({ type: "layout", direction: "horizontal", children: btns });
      if (state.confirmRemoveId) {
        var target = findServer(state.confirmRemoveId);
        children.push({
          type: "confirm",
          title: "Remove server",
          message: "Remove “" + (target ? target.name : "this server") + "”? Tracks already queued from it keep playing, and nothing on the server itself is deleted.",
          confirmLabel: "Remove",
          cancelLabel: "Cancel",
          confirmVariant: "danger",
          confirmAction: "confirm-remove",
          cancelAction: "cancel-remove",
          data: { id: state.confirmRemoveId },
        });
      }
    } else {
      children.push({ type: "spacer" });
      var serverRows = state.servers.map(function (s) {
        var status = state.downServers[s.id] ? "Unreachable" : "Connected";
        return { id: s.id, title: s.name, subtitle: hostOf(s.url) + "  ·  " + status, action: "open-server" };
      });
      var listNode = serverRows.length
        ? { type: "track-row-list", items: serverRows }
        : { type: "text", content: "No servers yet — add one to search, stream, and download across servers." };
      children.push({ type: "section", title: "Servers (" + state.servers.length + ")", children: [listNode] });
      children.push({ type: "spacer" });
      children.push({ type: "button", label: "+ Add a server", action: "add-server-new", className: "ds-btn ds-btn--primary", style: { alignSelf: "flex-start" } });
      if (state.addStatus) children.push({ type: "text", content: state.addStatus });
    }

    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: formMode ? (editing ? "manage-edit:" + editing.id : "manage-add") : "servers" });
  }

  // ---- About (in-panel tab) ---------------------------------------------
  function renderAbout() {
    api.ui.setViewData(VIEW, {
      type: "layout",
      direction: "vertical",
      children: [
        sectionTabs("about"),
        { type: "spacer" },
        { type: "section", title: "About", children: [
          { type: "text", content: "This is a live, multi-server browse layer — results are fetched on demand and are NOT added to your Library. To index a server into your Library (for unified search, Home shelves and tags), add it under Collections instead." },
        ] },
      ],
    }, { scrollKey: "about" });
  }

  // ---- Actions: search + play -------------------------------------------
  api.ui.onAction("do-search", function (data) {
    var q = ((data && data.query) || "").trim();
    if (!q) { state.query = ""; state.results = []; state.statusLine = ""; renderBrowse(); return; }
    runSearch(q).then(null, function (e) {
      console.error("subsonic-browse: search error:", e);
      state.searching = false; state.statusLine = "Search failed."; renderBrowse();
    });
  });

  api.ui.onAction("play-song", function (data) {
    var id = data && data.itemId;
    if (!id) return;
    var idx = -1;
    for (var i = 0; i < state.results.length; i++) {
      var p = primaryOf(state.results[i]);
      if (p.serverId + "/" + p.trackId === id) { idx = i; break; }
    }
    if (idx < 0) return;
    var tracks = state.results.map(toPluginTrack);
    api.playback.playTracks(tracks, idx, { name: "Subsonic: " + state.query, source: "search" });
  });

  // ---- Actions: tabs + drill-in + album play ----------------------------
  api.ui.onAction("switch-tab", function (data) {
    var t = data && data.tabId;
    if (t === "tracks" || t === "albums" || t === "artists") { state.activeTab = t; renderBrowse(); }
  });
  api.ui.onAction("open-album", function (data) { if (data && data.itemId) openAlbum(data.itemId); });
  api.ui.onAction("open-artist", function (data) { if (data && data.itemId) openArtist(data.itemId); });
  api.ui.onAction("back", function () { goBack(); });
  // Top-level section switch (Search / Manage tabs). Peers, not a drill-in —
  // no nav push; entity-detail drill-ins still use back/goBack within Search.
  api.ui.onAction("switch-section", function (data) {
    var t = data && data.tabId;
    state.nav = [];
    if (t === "manage") {
      state.view = "servers";
      state.editingId = null;
      state.addingNew = false;
      state.confirmRemoveId = null;
      state.form = { name: "", url: "", username: "", password: "" };
      state.addStatus = ""; state.addError = false;
    } else if (t === "about") {
      state.view = "about";
    } else {
      state.view = "results";
    }
    renderBrowse();
  });

  // Album play button (results card or artist-detail card) → fetch + play.
  api.ui.onAction("play-playlist", function (data) { if (data && data.itemId) playAlbumById(data.itemId); });
  // Album-detail header "play all".
  api.ui.onAction("play-detail-all", function () {
    if (!state.detailTracks.length) return;
    api.playback.playTracks(state.detailTracks, 0, { name: (state.detail && state.detail.title) || "Album", source: "playlist" });
  });
  // Album-detail per-track play (distinct from the results-tab play-song handler).
  api.ui.onAction("play-album-track", function (data) {
    var id = data && data.itemId;
    if (!id) return;
    var idx = -1;
    for (var i = 0; i < state.detailTracks.length; i++) {
      if (state.detailTracks[i].path === SCHEME + "://" + id) { idx = i; break; }
    }
    if (idx < 0) return;
    api.playback.playTracks(state.detailTracks, idx, { name: (state.detail && state.detail.title) || "Album", source: "playlist" });
  });

  // ---- Actions: add-server form -----------------------------------------
  // Re-render on each keystroke so the controlled inputs stay in sync (and clear
  // after a successful add). React preserves focus across these re-renders.
  api.ui.onAction("form-name", function (d) { state.form.name = (d && d.value) || ""; renderBrowse(); });
  api.ui.onAction("form-url", function (d) { state.form.url = (d && d.value) || ""; renderBrowse(); });
  api.ui.onAction("form-username", function (d) { state.form.username = (d && d.value) || ""; renderBrowse(); });
  api.ui.onAction("form-password", function (d) { state.form.password = (d && d.value) || ""; renderBrowse(); });

  // Open the in-tab edit form for an existing server (master-row tap).
  api.ui.onAction("open-server", function (data) {
    var s = findServer(data && data.itemId);
    if (!s) return;
    state.editingId = s.id;
    state.addingNew = false;
    state.form = { name: s.name, url: s.url, username: s.username, password: "" };
    state.addStatus = ""; state.addError = false; state.confirmRemoveId = null;
    renderBrowse();
  });

  // Open a blank in-tab add form.
  api.ui.onAction("add-server-new", function () {
    state.addingNew = true;
    state.editingId = null;
    state.form = { name: "", url: "", username: "", password: "" };
    state.addStatus = ""; state.addError = false; state.confirmRemoveId = null;
    renderBrowse();
  });

  // Return from the form to the server list (stays in the Manage tab).
  api.ui.onAction("back-to-list", function () {
    state.editingId = null;
    state.addingNew = false;
    state.form = { name: "", url: "", username: "", password: "" };
    state.addStatus = ""; state.addError = false; state.confirmRemoveId = null;
    renderBrowse();
  });

  // Save the add/edit form: test auth, persist, then drop back to the list.
  api.ui.onAction("save-server", async function () {
    var f = state.form;
    var editing = state.editingId ? findServer(state.editingId) : null;
    if (!f.url || !f.username) { state.addStatus = "Server URL and username are required."; state.addError = true; renderBrowse(); return; }
    state.adding = true; state.addStatus = ""; state.addError = false; renderBrowse();
    // On edit, a blank password keeps the current one.
    var password = (editing && !f.password) ? editing.password : f.password;
    var draft = { url: trimUrl(f.url), username: f.username, password: password };
    try {
      var method = await detectAuth(draft);
      if (editing) {
        editing.name = f.name || hostOf(draft.url);
        editing.url = draft.url;
        editing.username = draft.username;
        editing.password = password;
        editing.authMethod = method;
        delete state.downServers[editing.id];
        await persistServers();
        state.addStatus = "Saved “" + editing.name + "”.";
        api.ui.showNotification("Updated " + editing.name);
      } else {
        var server = { id: genId(), name: f.name || hostOf(draft.url), url: draft.url, username: draft.username, password: password, authMethod: method };
        state.servers.push(server);
        await persistServers();
        state.addStatus = "Added “" + server.name + "”.";
        api.ui.showNotification("Connected to " + server.name);
      }
      state.addError = false;
      // success → collapse back to the list (still in the Manage tab)
      state.editingId = null;
      state.addingNew = false;
      state.form = { name: "", url: "", username: "", password: "" };
    } catch (e) {
      console.error("subsonic-browse: failed to save server:", e);
      state.addStatus = "Could not connect: " + String((e && e.message) || e); state.addError = true;
      // failure → keep the form open so the user can fix it
    }
    state.adding = false;
    renderBrowse();
  });

  // Remove flow: ask first via the confirm modal, then delete (all in-tab).
  api.ui.onAction("ask-remove", function (data) {
    var id = (data && data.id) || state.editingId;
    if (!id) return;
    state.confirmRemoveId = id;
    renderBrowse();
  });
  api.ui.onAction("cancel-remove", function () {
    state.confirmRemoveId = null;
    renderBrowse();
  });
  api.ui.onAction("confirm-remove", function (data) {
    var id = (data && data.id) || state.confirmRemoveId;
    state.confirmRemoveId = null;
    if (!id) { renderBrowse(); return; }
    state.servers = state.servers.filter(function (s) { return s.id !== id; });
    delete state.downServers[id];
    persistServers().then(null, function (e) { console.error("subsonic-browse: persist after remove failed:", e); });
    state.editingId = null;
    state.addingNew = false;
    state.form = { name: "", url: "", username: "", password: "" };
    state.addStatus = "Removed server."; state.addError = false;
    renderBrowse();
  });

  function persistServers() { return api.storage.set("servers", state.servers); }

  // ---- Playback: stream resolvers ---------------------------------------
  // Scheme resolver for tracks this plugin surfaced. Prefers a healthy server
  // among known alternates so a track that exists on multiple servers fails
  // over when one is down.
  api.playback.onResolveStreamByUri(SCHEME, async function (id /*, quality */) {
    var candidates = state.alternates[id];
    if (!candidates) { var p = parseId(id); candidates = p ? [p] : []; }
    var ordered = candidates.slice().sort(function (a, b) {
      return (state.downServers[a.serverId] ? 1 : 0) - (state.downServers[b.serverId] ? 1 : 0);
    });
    for (var i = 0; i < ordered.length; i++) {
      var server = findServer(ordered[i].serverId);
      if (server) return streamUrl(server, ordered[i].trackId);
    }
    return null;
  });

  // Metadata fallback for ANY track (e.g. a library track whose source is gone):
  // search all servers and return the first exact match.
  api.playback.onStreamResolve(PROVIDER, async function (title, artistName /*, albumName, durationSecs */) {
    if (state.servers.length === 0) return null;
    var q = [artistName, title].filter(Boolean).join(" ") || title;
    if (!q) return null;
    var res = await searchAll(q, 10);
    var want = songKey(title, artistName);
    for (var i = 0; i < res.songs.length; i++) {
      var song = res.songs[i];
      if (songKey(song.title, song.artist) === want) {
        var server = findServer(primaryOf(song).serverId);
        if (server) return { url: streamUrl(server, primaryOf(song).trackId), label: "Subsonic: " + primaryOf(song).serverName };
      }
    }
    return null;
  });

  // ---- Downloads --------------------------------------------------------
  function downloadResult(server, trackId, meta) {
    // download.view = original file (no transcode); ext "auto" sniffs container.
    return { url: downloadUrl(server, trackId), headers: null, ext: "auto", metadata: meta || null };
  }

  api.downloads.onResolveByUri(PROVIDER, async function (uri /*, format */) {
    if (!uri || uri.indexOf(SCHEME + "://") !== 0) return null;
    var p = parseId(uri.slice((SCHEME + "://").length));
    if (!p) return null;
    var server = findServer(p.serverId);
    if (!server) return null;
    var meta = state.metaCache[p.serverId + "/" + p.trackId] || (await fetchSongMeta(server, p.trackId));
    return downloadResult(server, p.trackId, meta);
  });

  api.downloads.onInteractiveSearch(PROVIDER, async function (query, limit) {
    if (state.servers.length === 0) return [];
    var res = await searchAll(query, limit || 20);
    return res.songs.map(function (song) {
      var p = primaryOf(song);
      var server = findServer(p.serverId);
      var cover = coverUrl(server, song.coverId);
      var id = p.serverId + "/" + p.trackId;
      return {
        id: id,
        title: song.title,
        artistName: song.artist,
        albumTitle: song.album,
        coverUrl: cover,
        durationSecs: song.duration,
        trackNumber: song.track,
      };
    });
  });

  api.downloads.onInteractiveResolve(PROVIDER, async function (matchId /*, format */) {
    var p = parseId(matchId);
    if (!p) throw new Error("Invalid match id");
    var server = findServer(p.serverId);
    if (!server) throw new Error("Server no longer registered");
    var meta = state.metaCache[matchId] || (await fetchSongMeta(server, p.trackId));
    return downloadResult(server, p.trackId, meta);
  });

  // ---- Scrobble-back ----------------------------------------------------
  // When the host scrobbles one of our tracks, mirror it to the originating
  // server so its server-side play counts stay in sync.
  api.playback.onTrackScrobbled(function (track) {
    var path = track && track.path;
    if (!path || path.indexOf(SCHEME + "://") !== 0) return;
    var p = parseId(path.slice((SCHEME + "://").length));
    if (!p) return;
    var server = findServer(p.serverId);
    if (!server) return;
    api.network.fetch(restUrl(server, "scrobble.view", "id=" + enc(p.trackId) + "&submission=true")).then(
      null,
      function (e) { console.error("subsonic-browse: scrobble-back failed:", e); }
    );
  });

  // ---- Boot -------------------------------------------------------------
  api.storage.get("servers").then(
    function (saved) {
      if (Array.isArray(saved)) state.servers = saved;
      renderBrowse();
    },
    function (e) {
      console.error("subsonic-browse: failed to load servers:", e);
      renderBrowse();
    }
  );

  renderBrowse();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
