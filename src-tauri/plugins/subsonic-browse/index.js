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
  var SETTINGS = "subsonic-browse-settings";
  var SEARCH_TIMEOUT_MS = 8000;          // per-server budget; one slow server can't stall the rest
  var PER_SERVER_LIMIT = 40;

  // ---- in-memory state --------------------------------------------------
  var state = {
    servers: [],            // [{id,name,url,username,password,authMethod}]
    form: { name: "", url: "", username: "", password: "" },
    adding: false,
    addStatus: "",
    addError: false,
    query: "",
    searching: false,
    results: [],            // merged songs (ordered); each has .alternates[]
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
  // lines up with the rest of the app (Björk == Bjork, etc.).
  function norm(s) {
    if (!s) return "";
    return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
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
        resolve({ server: server, ok: false, songs: [], error: "timed out" });
      }, SEARCH_TIMEOUT_MS);
      subsonicGet(server, "search3.view", "query=" + enc(query) + "&songCount=" + limit + "&artistCount=0&albumCount=0").then(
        function (r) {
          if (done) return;
          done = true; clearTimeout(timer);
          delete state.downServers[server.id];
          var songs = (r.searchResult3 && r.searchResult3.song) || [];
          resolve({ server: server, ok: true, songs: songs.map(function (s) { return mapSong(server, s); }) });
        },
        function (err) {
          if (done) return;
          done = true; clearTimeout(timer);
          state.downServers[server.id] = true;
          console.error("subsonic-browse: search failed on " + server.name + ":", err);
          resolve({ server: server, ok: false, songs: [], error: String((err && err.message) || err) });
        }
      );
    });
  }

  // Run a query across every server, merge + dedup. Duplicates (same song on
  // multiple servers) collapse into one row that carries all copies as
  // `alternates` (enables play-time failover + a "N servers" affordance).
  async function searchAll(query, limit) {
    var settled = await Promise.all(state.servers.map(function (s) { return searchServerSafe(s, query, limit); }));
    var merged = [], byKey = {}, ok = 0, fail = 0, failNames = [];
    settled.forEach(function (res) {
      if (res.ok) ok++; else { fail++; failNames.push(res.server.name); }
      res.songs.forEach(function (song) {
        var key = songKey(song.title, song.artist);
        var alt = { serverId: song.serverId, trackId: song.trackId, serverName: song.serverName };
        if (byKey[key] != null) { merged[byKey[key]].alternates.push(alt); return; }
        song.alternates = [alt];
        byKey[key] = merged.length;
        merged.push(song);
      });
    });
    return { merged: merged, ok: ok, fail: fail, failNames: failNames };
  }

  function rank(song, q) {
    var t = (song.title || "").toLowerCase();
    if (t === q) return 0;
    if (t.indexOf(q) === 0) return 1;
    if (t.indexOf(q) >= 0) return 2;
    return 3;
  }

  async function runSearch(query) {
    state.searching = true;
    state.query = query;
    renderBrowse();
    var res = await searchAll(query, PER_SERVER_LIMIT);
    var q = query.toLowerCase();
    res.merged.sort(function (a, b) {
      var d = rank(a, q) - rank(b, q);
      return d !== 0 ? d : (a.title || "").localeCompare(b.title || "");
    });
    // Index every copy -> the full alternates list, so the stream resolver can
    // fail over no matter which server's id ends up encoded in the queue path.
    state.alternates = {};
    res.merged.forEach(function (song) {
      song.alternates.forEach(function (alt) {
        state.alternates[alt.serverId + "/" + alt.trackId] = song.alternates;
      });
    });
    state.results = res.merged;
    state.statusLine = buildStatus(res, res.merged.length);
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

  function renderBrowse() {
    var children = [];
    children.push({
      type: "search-input",
      placeholder: "Search all servers…",
      action: "do-search",
      submitOnly: true,
      buttonLabel: "Search",
      value: state.query,
    });
    if (state.servers.length === 0) {
      children.push({ type: "text", content: "No servers connected yet. Add one in Settings → Subsonic Servers to search, stream, and download across servers." });
    } else if (state.searching) {
      children.push({ type: "loading", message: "Searching " + state.servers.length + " server" + (state.servers.length > 1 ? "s" : "") + "…" });
    } else if (state.query) {
      if (state.statusLine) children.push({ type: "text", content: state.statusLine });
      if (state.results.length === 0) children.push({ type: "text", content: "No results." });
      else children.push({ type: "track-row-list", showHeader: true, items: state.results.map(rowFromSong) });
    } else {
      children.push({ type: "text", content: state.servers.length + " server" + (state.servers.length > 1 ? "s" : "") + " connected. Type a query to search across all of them at once." });
    }
    api.ui.setViewData(VIEW, { type: "layout", direction: "vertical", children: children }, { scrollKey: state.query ? "q:" + state.query : "home" });
  }

  // ---- Settings (server management) -------------------------------------
  function renderSettings() {
    var serverRows = state.servers.map(function (s) {
      var status = state.downServers[s.id] ? "Unreachable" : "Connected";
      return {
        type: "settings-row",
        label: s.name,
        description: s.url + "  ·  " + s.username + "  ·  " + status + "  ·  auth: " + s.authMethod,
        control: { type: "button", label: "Remove", action: "remove-server", variant: "secondary", data: { id: s.id } },
      };
    });

    var addChildren = [
      { type: "settings-row", label: "Name", description: "A label for this server (optional)", control: { type: "text-input", placeholder: "My server", action: "form-name", value: state.form.name } },
      { type: "settings-row", label: "Server URL", description: "e.g. https://music.example.com", control: { type: "text-input", placeholder: "https://…", action: "form-url", value: state.form.url } },
      { type: "settings-row", label: "Username", control: { type: "text-input", placeholder: "user", action: "form-username", value: state.form.username } },
      { type: "settings-row", label: "Password", description: "Stored locally; sent to the server over your connection", control: { type: "text-input", placeholder: "password", action: "form-password", value: state.form.password } },
      { type: "button", label: state.adding ? "Testing…" : "Test & Add", action: "add-server", variant: "accent", disabled: state.adding },
    ];
    if (state.addStatus) addChildren.push({ type: "text", content: state.addStatus });

    api.ui.setViewData(SETTINGS, {
      type: "layout",
      direction: "vertical",
      children: [
        { type: "section", title: "Servers", children: serverRows.length ? serverRows : [{ type: "text", content: "No servers added yet." }] },
        { type: "section", title: "Add a server", children: addChildren },
        { type: "section", title: "About", children: [
          { type: "text", content: "This is a live, multi-server browse layer — results are fetched on demand and are NOT added to your Library. To index a server into your Library (for unified search, Home shelves and tags), add it under Collections instead." },
        ] },
      ],
    });
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

  // ---- Actions: add-server form -----------------------------------------
  // Re-render on each keystroke so the controlled inputs stay in sync (and clear
  // after a successful add). React preserves focus across these re-renders.
  api.ui.onAction("form-name", function (d) { state.form.name = (d && d.value) || ""; renderSettings(); });
  api.ui.onAction("form-url", function (d) { state.form.url = (d && d.value) || ""; renderSettings(); });
  api.ui.onAction("form-username", function (d) { state.form.username = (d && d.value) || ""; renderSettings(); });
  api.ui.onAction("form-password", function (d) { state.form.password = (d && d.value) || ""; renderSettings(); });

  api.ui.onAction("add-server", async function () {
    var f = state.form;
    if (!f.url || !f.username) { state.addStatus = "Server URL and username are required."; state.addError = true; renderSettings(); return; }
    state.adding = true; state.addStatus = ""; state.addError = false; renderSettings();
    var draft = { url: trimUrl(f.url), username: f.username, password: f.password };
    try {
      var method = await detectAuth(draft);
      var server = { id: genId(), name: f.name || hostOf(draft.url), url: draft.url, username: draft.username, password: draft.password, authMethod: method };
      state.servers.push(server);
      await persistServers();
      state.form = { name: "", url: "", username: "", password: "" };
      state.addStatus = "Added “" + server.name + "”."; state.addError = false;
      api.ui.showNotification("Connected to " + server.name);
    } catch (e) {
      console.error("subsonic-browse: failed to add server:", e);
      state.addStatus = "Could not connect: " + String((e && e.message) || e); state.addError = true;
    }
    state.adding = false;
    renderSettings();
    renderBrowse();
  });

  api.ui.onAction("remove-server", function (data) {
    var id = data && data.id;
    if (!id) return;
    state.servers = state.servers.filter(function (s) { return s.id !== id; });
    delete state.downServers[id];
    persistServers().then(null, function (e) { console.error("subsonic-browse: persist after remove failed:", e); });
    renderSettings();
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
    for (var i = 0; i < res.merged.length; i++) {
      var song = res.merged[i];
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
    return res.merged.map(function (song) {
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
      renderSettings();
      renderBrowse();
    },
    function (e) {
      console.error("subsonic-browse: failed to load servers:", e);
      renderSettings();
      renderBrowse();
    }
  );

  renderSettings();
  renderBrowse();
}

function deactivate() {}

return { activate: activate, deactivate: deactivate };
