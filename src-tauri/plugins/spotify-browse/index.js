// Spotify Browse Plugin for Viboplr
// Provides Spotify library browsing — personalized feed, liked songs, and playlists

function activate(api) {
  var SPOTIFY_CLIENT_ID = "44d2ad940a874b629112797a45b36a13";
  var SPOTIFY_REDIRECT_URI = "viboplr://spotify/callback";
  var SPOTIFY_SCOPES = "user-library-read playlist-read-private";

  var state = {
    accessToken: null,
    refreshToken: null,
    tokenExpiry: 0,
    codeVerifier: null,
    currentView: "home",
    likedTracks: [],
    likedOffset: 0,
    likedTotal: 0,
    playlists: [],
    homeSections: [],
    playlistTracks: [],
    playlistTracksOffset: 0,
    playlistTracksTotal: 0,
    currentPlaylist: null,
    userName: null,
    searchQuery: "",
    searchResults: { tracks: [], artists: [], albums: [] },
    searchTab: "tracks",
    detailTrack: null,
    spDcCookie: null,
    webPlayerToken: null,
    webPlayerTokenExpiry: 0,
  };

  // -- PKCE helpers --

  function generateRandomString(length) {
    var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    var result = "";
    for (var i = 0; i < length; i++) {
      result += chars[arr[i] % chars.length];
    }
    return result;
  }

  function base64UrlEncode(buffer) {
    var bytes = new Uint8Array(buffer);
    var str = "";
    for (var i = 0; i < bytes.length; i++) {
      str += String.fromCharCode(bytes[i]);
    }
    return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function generateCodeChallenge(verifier) {
    var encoder = new TextEncoder();
    var data = encoder.encode(verifier);
    return crypto.subtle.digest("SHA-256", data).then(function (hash) {
      return base64UrlEncode(hash);
    });
  }

  // -- Spotify API helpers --

  function spotifyFetch(path, opts) {
    return ensureToken().then(function () {
      if (!state.accessToken) throw new Error("Not authenticated");
      var headers = {
        "Authorization": "Bearer " + state.accessToken,
      };
      if (opts && opts.body) headers["Content-Type"] = "application/json";
      return api.network.fetch("https://api.spotify.com/v1" + path, {
        method: (opts && opts.method) || "GET",
        headers: headers,
        body: opts && opts.body,
      });
    }).then(function (resp) {
      if (resp.status === 401) {
        return refreshAccessToken().then(function () {
          return api.network.fetch("https://api.spotify.com/v1" + path, {
            method: (opts && opts.method) || "GET",
            headers: {
              "Authorization": "Bearer " + state.accessToken,
            },
            body: opts && opts.body,
          });
        });
      }
      return resp;
    }).then(function (resp) {
      if (resp.status >= 400) {
        return resp.text().then(function (text) {
          throw new Error("Spotify API error " + resp.status + ": " + text);
        });
      }
      return resp.json();
    });
  }

  function ensureToken() {
    if (state.accessToken && Date.now() < state.tokenExpiry) {
      return Promise.resolve();
    }
    if (state.refreshToken) {
      return refreshAccessToken();
    }
    return Promise.resolve();
  }

  function refreshAccessToken() {
    if (!state.refreshToken) return Promise.resolve();
    var body = "grant_type=refresh_token"
      + "&refresh_token=" + encodeURIComponent(state.refreshToken)
      + "&client_id=" + encodeURIComponent(SPOTIFY_CLIENT_ID);
    return api.network.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    }).then(function (resp) {
      if (resp.status !== 200) {
        state.accessToken = null;
        state.refreshToken = null;
        api.storage.delete("spotify_tokens");
        renderSetup("Session expired. Please reconnect.");
        return;
      }
      return resp.json().then(function (data) {
        state.accessToken = data.access_token;
        state.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
        if (data.refresh_token) {
          state.refreshToken = data.refresh_token;
        }
        return api.storage.set("spotify_tokens", {
          accessToken: state.accessToken,
          refreshToken: state.refreshToken,
          tokenExpiry: state.tokenExpiry,
        });
      });
    });
  }

  // -- Auth flow --

  function startAuth() {
    console.log("[spotify] startAuth: generating PKCE verifier");
    state.codeVerifier = generateRandomString(128);
    generateCodeChallenge(state.codeVerifier).then(function (challenge) {
      var url = "https://accounts.spotify.com/authorize"
        + "?client_id=" + encodeURIComponent(SPOTIFY_CLIENT_ID)
        + "&response_type=code"
        + "&redirect_uri=" + encodeURIComponent(SPOTIFY_REDIRECT_URI)
        + "&scope=" + encodeURIComponent(SPOTIFY_SCOPES)
        + "&code_challenge_method=S256"
        + "&code_challenge=" + encodeURIComponent(challenge);
      console.log("[spotify] startAuth: opening browser with redirect_uri=" + SPOTIFY_REDIRECT_URI);
      return api.network.openUrl(url);
    }).then(function () {
      console.log("[spotify] startAuth: browser opened, waiting for callback deep link...");
    }).catch(function (err) {
      console.error("[spotify] startAuth error:", err);
      renderError("Failed to start auth: " + (err.message || err));
    });
  }

  function handleCallback(code) {
    console.log("[spotify] handleCallback: code=" + code.substring(0, 10) + "...");
    if (!state.codeVerifier) {
      console.error("[spotify] handleCallback: no codeVerifier! Auth state was lost.");
      return;
    }
    console.log("[spotify] handleCallback: exchanging code for token...");
    var body = "grant_type=authorization_code"
      + "&code=" + encodeURIComponent(code)
      + "&redirect_uri=" + encodeURIComponent(SPOTIFY_REDIRECT_URI)
      + "&client_id=" + encodeURIComponent(SPOTIFY_CLIENT_ID)
      + "&code_verifier=" + encodeURIComponent(state.codeVerifier);
    renderLoading("Authenticating...");
    api.network.fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body,
    }).then(function (resp) {
      console.log("[spotify] handleCallback: token response status=" + resp.status);
      if (resp.status !== 200) {
        return resp.text().then(function (text) {
          throw new Error("Token exchange failed: " + text);
        });
      }
      return resp.json();
    }).then(function (data) {
      console.log("[spotify] handleCallback: got access_token, expires_in=" + data.expires_in);
      state.accessToken = data.access_token;
      state.refreshToken = data.refresh_token;
      state.tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
      state.codeVerifier = null;
      return api.storage.set("spotify_tokens", {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        tokenExpiry: state.tokenExpiry,
      });
    }).then(function () {
      console.log("[spotify] handleCallback: tokens saved, fetching profile...");
      return fetchUserProfile();
    }).then(function () {
      return loadHome();
    }).catch(function (err) {
      console.error("[spotify] handleCallback error:", err);
      renderError("Authentication failed: " + (err.message || err));
    });
  }

  // Deep link callback handler (receives viboplr://spotify/callback?code=...)
  console.log("[spotify] registering onDeepLink handler");
  api.network.onDeepLink(function (url) {
    console.log("[spotify] onDeepLink fired, url=" + url);
    if (url.indexOf("viboplr://spotify/callback") !== 0) {
      console.log("[spotify] onDeepLink: ignoring, not a spotify callback");
      return;
    }
    var qIndex = url.indexOf("?");
    if (qIndex === -1) {
      console.log("[spotify] onDeepLink: no query string in URL");
      return;
    }
    var params = new URLSearchParams(url.substring(qIndex + 1));
    var code = params.get("code");
    var error = params.get("error");
    console.log("[spotify] onDeepLink: code=" + (code ? code.substring(0, 10) + "..." : "null") + ", error=" + error);
    if (error) {
      renderError("Spotify authorization denied: " + error);
      return;
    }
    if (code) {
      handleCallback(code);
    }
  });

  function fetchUserProfile() {
    return spotifyFetch("/me").then(function (profile) {
      state.userName = profile.display_name || profile.id;
      return api.storage.set("spotify_user", state.userName);
    }).catch(function (e) {
      console.error("Failed to fetch profile:", e);
    });
  }

  // -- Data loading --

  function fetchAllPlaylists() {
    var allPlaylists = [];
    var maxPages = 200;

    function fetchPage(offset, page) {
      return spotifyFetch("/me/playlists?limit=50&offset=" + offset).then(function (resp) {
        var items = resp.items || [];
        for (var i = 0; i < items.length; i++) {
          allPlaylists.push(items[i]);
        }
        var total = resp.total || 0;
        if (offset + 50 < total && page < maxPages) {
          return fetchPage(offset + 50, page + 1);
        }
        return allPlaylists;
      });
    }

    return fetchPage(0, 1);
  }

  function parseHomeFeedSection(section) {
    if (!section || !section.content || !section.content.items) return null;
    var title = section.name || section.tag_line || "";
    if (!title) return null;
    var items = [];
    var sectionItems = section.content.items;
    for (var i = 0; i < sectionItems.length; i++) {
      var item = sectionItems[i];
      if (!item) continue;
      var type = null;
      var uri = item.uri || "";
      if (uri.indexOf("spotify:playlist:") === 0) type = "playlist";
      else if (uri.indexOf("spotify:album:") === 0) type = "album";
      else if (uri.indexOf("spotify:artist:") === 0) type = "artist";
      else if (item.content_type === "PLAYLIST") type = "playlist";
      else if (item.content_type === "ALBUM") type = "album";
      else if (item.content_type === "ARTIST") type = "artist";
      if (!type) continue;
      var id = uri.split(":").pop() || item.id || "";
      if (!id) continue;
      var img = null;
      if (item.images) {
        if (item.images.length > 0 && item.images[0].url) {
          img = item.images[0].url;
        }
      }
      items.push({
        id: id,
        name: item.name || "",
        description: item.description || "",
        imageUrl: img,
        type: type,
        uri: uri,
      });
    }
    if (items.length === 0) return null;
    return { title: title, items: items };
  }

  // -- Web player token via sp_dc cookie --

  function ensureWebPlayerToken() {
    if (state.webPlayerToken && Date.now() < state.webPlayerTokenExpiry) {
      return Promise.resolve(state.webPlayerToken);
    }
    if (!state.spDcCookie) return Promise.resolve(null);
    return api.network.fetch("https://open.spotify.com/get_access_token?reason=transport&productType=web_player", {
      method: "GET",
      headers: {
        "Cookie": "sp_dc=" + state.spDcCookie,
      },
    }).then(function (resp) {
      if (resp.status !== 200) {
        return resp.text().then(function (text) {
          console.warn("[spotify] Web player token fetch failed (" + resp.status + "):", text);
          return null;
        });
      }
      return resp.json();
    }).then(function (data) {
      if (!data || !data.accessToken || data.isAnonymous) {
        console.warn("[spotify] Web player token invalid or anonymous — sp_dc cookie may be expired");
        return null;
      }
      state.webPlayerToken = data.accessToken;
      state.webPlayerTokenExpiry = (data.accessTokenExpirationTimestampMs || 0) - 60000;
      console.log("[spotify] Web player token acquired, expires in " + Math.round((state.webPlayerTokenExpiry - Date.now()) / 60000) + " min");
      return state.webPlayerToken;
    }).catch(function (err) {
      console.warn("[spotify] Web player token error:", err.message || err);
      return null;
    });
  }

  // -- Home feed fetching (3-tier: sp_dc token → OAuth + headers → official API) --

  function fetchHomeFeedWithToken(token) {
    return api.network.fetch("https://api.spotify.com/v1/views/desktop-home?content_limit=10&locale=en&platform=web&types=album,playlist,artist&limit=20&offset=0", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + token,
        "app-platform": "WebPlayer",
      },
    }).then(function (resp) {
      if (resp.status >= 400) {
        return resp.text().then(function (text) {
          throw new Error("Internal API error " + resp.status + ": " + text);
        });
      }
      return resp.json();
    }).then(function (resp) {
      var sections = [];
      var content = resp.content || resp;
      var rawSections = content.items || content.sections || [];
      for (var i = 0; i < rawSections.length; i++) {
        var parsed = parseHomeFeedSection(rawSections[i]);
        if (parsed) sections.push(parsed);
      }
      return sections;
    });
  }

  // Tier 1: Try with web player token from sp_dc cookie
  function fetchHomeFeedViaCookie() {
    return ensureWebPlayerToken().then(function (wpToken) {
      if (!wpToken) throw new Error("No web player token");
      return fetchHomeFeedWithToken(wpToken);
    }).then(function (sections) {
      if (sections.length > 0) {
        console.log("[spotify] Home feed loaded: " + sections.length + " sections via sp_dc web player token");
      }
      return sections;
    });
  }

  // Tier 2: Try with standard OAuth token + web player headers
  function fetchHomeFeedViaOAuth() {
    return ensureToken().then(function () {
      if (!state.accessToken) throw new Error("Not authenticated");
      return fetchHomeFeedWithToken(state.accessToken);
    }).then(function (sections) {
      if (sections.length > 0) {
        console.log("[spotify] Home feed loaded: " + sections.length + " sections via OAuth token");
      }
      return sections;
    });
  }

  // Tier 3: Official Browse Categories API for "Made For You"
  function fetchMadeForYouFallback() {
    return spotifyFetch("/browse/categories/0JQ5DAt0tbjZptfcdMSKl3/playlists?limit=20")
      .then(function (resp) {
        var playlists = (resp.playlists && resp.playlists.items) || [];
        if (playlists.length === 0) return [];
        var items = [];
        for (var i = 0; i < playlists.length; i++) {
          var p = playlists[i];
          if (!p) continue;
          var img = null;
          if (p.images && p.images.length > 0) img = p.images[0].url;
          items.push({
            id: p.id,
            name: p.name || "",
            description: p.description || "",
            imageUrl: img,
            type: "playlist",
            uri: p.uri || ("spotify:playlist:" + p.id),
          });
        }
        console.log("[spotify] Made For You loaded: " + items.length + " playlists via official API");
        return items.length > 0 ? [{ title: "Made For You", items: items }] : [];
      })
      .catch(function (err) {
        console.warn("[spotify] Made For You category also unavailable:", err.message || err);
        return [];
      });
  }

  function fetchHomeFeed() {
    // Tier 1: sp_dc cookie → web player token
    return fetchHomeFeedViaCookie()
      .catch(function (err) {
        console.log("[spotify] Tier 1 (sp_dc cookie): " + (err.message || err));
        // Tier 2: standard OAuth token + web player headers
        return fetchHomeFeedViaOAuth();
      })
      .catch(function (err) {
        console.log("[spotify] Tier 2 (OAuth + headers): " + (err.message || err));
        // Tier 3: official API fallback
        return fetchMadeForYouFallback();
      });
  }

  function loadHome() {
    renderLoading("Loading your library...");
    state.homeSections = [];

    var homeFeedPromise = fetchHomeFeed();
    var playlistsPromise = fetchAllPlaylists();
    var likedPromise = spotifyFetch("/me/tracks?limit=1");

    return Promise.all([homeFeedPromise, playlistsPromise, likedPromise])
      .then(function (results) {
        state.homeSections = results[0] || [];
        state.playlists = results[1] || [];
        state.likedTotal = (results[2] && results[2].total) || 0;
        state.currentView = "home";
        renderHome();
      })
      .catch(function (err) {
        renderError("Failed to load library: " + (err.message || err));
      });
  }

  function loadLikedTracks(offset) {
    renderLoading("Loading liked songs...");
    return spotifyFetch("/me/tracks?limit=50&offset=" + (offset || 0)).then(function (resp) {
      state.likedTracks = [];
      var items = resp.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].track) state.likedTracks.push(items[i].track);
      }
      state.likedOffset = offset || 0;
      state.likedTotal = resp.total || 0;
      state.currentView = "liked";
      renderLiked();
    }).catch(function (err) {
      renderError("Failed to load liked songs: " + (err.message || err));
    });
  }

  function loadPlaylistTracks(playlist, offset) {
    renderLoading("Loading playlist...");
    return spotifyFetch("/playlists/" + playlist.id + "/tracks?limit=50&offset=" + (offset || 0)).then(function (resp) {
      state.playlistTracks = [];
      var items = resp.items || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].track) state.playlistTracks.push(items[i].track);
      }
      state.playlistTracksOffset = offset || 0;
      state.playlistTracksTotal = resp.total || 0;
      state.currentPlaylist = playlist;
      state.currentView = "playlist";
      renderPlaylist();
    }).catch(function (err) {
      renderError("Failed to load playlist: " + (err.message || err));
    });
  }

  // -- Search --

  function searchSpotify(query) {
    if (!query || !query.trim()) return Promise.resolve();
    state.searchQuery = query.trim();
    renderLoading("Searching...");
    return spotifyFetch("/search?q=" + encodeURIComponent(state.searchQuery) + "&type=track,artist,album&limit=20")
      .then(function (resp) {
        state.searchResults = {
          tracks: (resp.tracks && resp.tracks.items) || [],
          artists: (resp.artists && resp.artists.items) || [],
          albums: (resp.albums && resp.albums.items) || [],
        };
        state.currentView = "search";
        renderSearch();
      })
      .catch(function (err) {
        renderError("Search failed: " + (err.message || err));
      });
  }

  function loadTrackDetail(trackId) {
    renderLoading("Loading track...");
    return spotifyFetch("/tracks/" + trackId)
      .then(function (track) {
        state.detailTrack = track;
        state.currentView = "detail";
        renderDetail();
      })
      .catch(function (err) {
        renderError("Failed to load track: " + (err.message || err));
      });
  }

  // -- Rendering --

  function escapeHtml(str) {
    if (!str) return "";
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function formatDuration(ms) {
    if (!ms) return "";
    var secs = Math.floor(ms / 1000);
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function getArtistNames(t) {
    if (!t.artists) return "Unknown";
    var names = [];
    for (var i = 0; i < t.artists.length; i++) {
      names.push(t.artists[i].name);
    }
    return names.join(", ");
  }

  function spotifyTrackToRow(t) {
    var img;
    if (t.album && t.album.images && t.album.images.length > 0) {
      img = t.album.images[t.album.images.length - 1].url;
    }
    return {
      id: "track:" + t.id,
      title: t.name,
      subtitle: getArtistNames(t) + (t.album ? " \u2014 " + t.album.name : ""),
      imageUrl: img,
      duration: formatDuration(t.duration_ms),
      action: "view-track",
    };
  }

  function renderSetup(message) {
    var children = [];
    if (message) {
      children.push({ type: "text", content: "<p>" + escapeHtml(message) + "</p>" });
      children.push({ type: "spacer" });
    }
    children.push({ type: "text", content: "<h3>Connect to Spotify</h3>" });
    children.push({ type: "text", content: "<p>Sign in with your Spotify account to browse your library.</p>" });
    children.push({ type: "button", label: "Connect with Spotify", action: "start-auth" });
    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderHome() {
    var children = [];

    if (state.userName) {
      children.push({ type: "text", content: "<p style='opacity:0.6'>" + escapeHtml(state.userName) + "'s Library</p>" });
    }

    // Search bar
    children.push({ type: "search-input", placeholder: "Search Spotify...", action: "search", value: "" });
    children.push({ type: "spacer" });

    // Personalized sections from home feed
    for (var s = 0; s < state.homeSections.length; s++) {
      var section = state.homeSections[s];
      children.push({ type: "text", content: "<h3>" + escapeHtml(section.title) + "</h3>" });
      var sectionItems = [];
      for (var si = 0; si < section.items.length; si++) {
        var item = section.items[si];
        var action = null;
        var itemId = null;
        if (item.type === "playlist") {
          action = "view-playlist";
          itemId = "playlist:" + item.id;
        } else if (item.type === "album") {
          action = "open-spotify-uri";
          itemId = "uri:" + item.uri;
        } else if (item.type === "artist") {
          action = "open-spotify-uri";
          itemId = "uri:" + item.uri;
        }
        sectionItems.push({
          id: itemId || item.id,
          title: item.name,
          subtitle: item.description || "",
          imageUrl: item.imageUrl,
          action: action,
        });
      }
      children.push({ type: "card-grid", items: sectionItems });
      children.push({ type: "spacer" });
    }

    // Liked songs card
    children.push({
      type: "card-grid",
      columns: 3,
      items: [{
        id: "liked",
        title: "Liked Songs",
        subtitle: state.likedTotal + " tracks",
        action: "view-liked",
      }],
    });

    children.push({ type: "spacer" });

    // Playlists
    if (state.playlists.length > 0) {
      children.push({ type: "text", content: "<h3>Playlists</h3>" });
      var items = [];
      for (var i = 0; i < state.playlists.length; i++) {
        var p = state.playlists[i];
        var img;
        if (p.images && p.images.length > 0) img = p.images[0].url;
        items.push({
          id: "playlist:" + p.id,
          title: p.name,
          subtitle: (p.tracks ? p.tracks.total : 0) + " tracks",
          imageUrl: img,
          action: "view-playlist",
        });
      }
      children.push({ type: "card-grid", items: items });
    }

    children.push({ type: "spacer" });
    children.push({
      type: "layout",
      direction: "horizontal",
      children: [
        { type: "button", label: "Refresh", action: "refresh-home" },
        { type: "button", label: "Settings", action: "show-settings" },
        { type: "button", label: "Disconnect", action: "disconnect" },
      ],
    });

    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderLiked() {
    var children = [
      { type: "button", label: "\u2190 Back", action: "go-home" },
      { type: "spacer" },
      { type: "text", content: "<h2>Liked Songs</h2>" },
      { type: "text", content: "<p style='opacity:0.6'>" + state.likedTotal + " tracks</p>" },
    ];

    if (state.likedTracks.length > 0) {
      var items = [];
      for (var i = 0; i < state.likedTracks.length; i++) {
        items.push(spotifyTrackToRow(state.likedTracks[i]));
      }
      children.push({ type: "track-row-list", items: items });
    }

    // Pagination
    var paginationButtons = [];
    if (state.likedOffset > 0) {
      paginationButtons.push({ type: "button", label: "\u2190 Previous", action: "liked-prev" });
    }
    if (state.likedOffset + 50 < state.likedTotal) {
      paginationButtons.push({ type: "button", label: "Next \u2192", action: "liked-next" });
    }
    if (paginationButtons.length > 0) {
      children.push({ type: "spacer" });
      children.push({ type: "layout", direction: "horizontal", children: paginationButtons });
    }

    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderPlaylist() {
    var playlist = state.currentPlaylist;
    var children = [
      { type: "button", label: "\u2190 Back", action: "go-home" },
      { type: "spacer" },
      { type: "text", content: "<h2>" + escapeHtml(playlist.name) + "</h2>" },
      { type: "text", content: "<p style='opacity:0.6'>" + state.playlistTracksTotal + " tracks</p>" },
    ];

    // Playlist cover
    if (playlist.images && playlist.images.length > 0) {
      children.push({
        type: "card-grid",
        columns: 3,
        items: [{ id: "cover", title: "", imageUrl: playlist.images[0].url }],
      });
      children.push({ type: "spacer" });
    }

    if (state.playlistTracks.length > 0) {
      var items = [];
      for (var i = 0; i < state.playlistTracks.length; i++) {
        items.push(spotifyTrackToRow(state.playlistTracks[i]));
      }
      children.push({ type: "track-row-list", items: items });
    }

    // Pagination
    var paginationButtons = [];
    if (state.playlistTracksOffset > 0) {
      paginationButtons.push({ type: "button", label: "\u2190 Previous", action: "playlist-prev" });
    }
    if (state.playlistTracksOffset + 50 < state.playlistTracksTotal) {
      paginationButtons.push({ type: "button", label: "Next \u2192", action: "playlist-next" });
    }
    if (paginationButtons.length > 0) {
      children.push({ type: "spacer" });
      children.push({ type: "layout", direction: "horizontal", children: paginationButtons });
    }

    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderSearch() {
    var children = [
      { type: "button", label: "\u2190 Back", action: "go-home" },
      { type: "spacer" },
      { type: "search-input", placeholder: "Search Spotify...", action: "search", value: state.searchQuery },
      { type: "spacer" },
    ];

    var trackCount = state.searchResults.tracks.length;
    var artistCount = state.searchResults.artists.length;
    var albumCount = state.searchResults.albums.length;

    children.push({
      type: "tabs",
      tabs: [
        { id: "tracks", label: "Tracks", count: trackCount },
        { id: "artists", label: "Artists", count: artistCount },
        { id: "albums", label: "Albums", count: albumCount },
      ],
      activeTab: state.searchTab,
      action: "search-tab",
    });

    children.push({ type: "spacer" });

    if (state.searchTab === "tracks" && trackCount > 0) {
      var items = [];
      for (var i = 0; i < state.searchResults.tracks.length; i++) {
        items.push(spotifyTrackToRow(state.searchResults.tracks[i]));
      }
      children.push({ type: "track-row-list", items: items });
    } else if (state.searchTab === "artists" && artistCount > 0) {
      var artistItems = [];
      for (var j = 0; j < state.searchResults.artists.length; j++) {
        var a = state.searchResults.artists[j];
        var aImg;
        if (a.images && a.images.length > 0) aImg = a.images[a.images.length - 1].url;
        artistItems.push({
          id: "artist:" + a.id,
          title: a.name,
          subtitle: (a.followers ? a.followers.total.toLocaleString() + " followers" : "") + (a.genres && a.genres.length > 0 ? " \u00B7 " + a.genres.slice(0, 2).join(", ") : ""),
          imageUrl: aImg,
        });
      }
      children.push({ type: "card-grid", items: artistItems, columns: 3 });
    } else if (state.searchTab === "albums" && albumCount > 0) {
      var albumItems = [];
      for (var k = 0; k < state.searchResults.albums.length; k++) {
        var al = state.searchResults.albums[k];
        var alImg;
        if (al.images && al.images.length > 0) alImg = al.images[al.images.length - 1].url;
        var albumArtist = al.artists && al.artists.length > 0 ? al.artists[0].name : "";
        albumItems.push({
          id: "album:" + al.id,
          title: al.name,
          subtitle: albumArtist + (al.release_date ? " \u00B7 " + al.release_date.substring(0, 4) : ""),
          imageUrl: alImg,
        });
      }
      children.push({ type: "card-grid", items: albumItems, columns: 3 });
    } else {
      children.push({ type: "text", content: "<p style='opacity:0.5'>No results</p>" });
    }

    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderDetail() {
    var t = state.detailTrack;
    if (!t) return;

    var children = [
      { type: "button", label: "\u2190 Back", action: "detail-back" },
      { type: "spacer" },
    ];

    // Album art
    if (t.album && t.album.images && t.album.images.length > 0) {
      children.push({
        type: "card-grid",
        columns: 3,
        items: [{ id: "art", title: "", imageUrl: t.album.images[0].url }],
      });
      children.push({ type: "spacer" });
    }

    children.push({ type: "text", content: "<h2>" + escapeHtml(t.name) + "</h2>" });
    children.push({ type: "text", content: "<p>" + escapeHtml(getArtistNames(t)) + "</p>" });

    // Stats grid
    var stats = [];
    if (t.album) stats.push({ label: "Album", value: t.album.name });
    if (t.duration_ms) stats.push({ label: "Duration", value: formatDuration(t.duration_ms) });
    if (t.popularity != null) stats.push({ label: "Popularity", value: t.popularity + " / 100" });
    if (t.album && t.album.release_date) stats.push({ label: "Released", value: t.album.release_date });
    if (t.track_number) stats.push({ label: "Track #", value: t.track_number + (t.album && t.album.total_tracks ? " of " + t.album.total_tracks : "") });
    if (t.disc_number && t.disc_number > 1) stats.push({ label: "Disc", value: String(t.disc_number) });
    if (t.explicit) stats.push({ label: "Explicit", value: "Yes" });
    stats.push({ label: "Spotify ID", value: t.id });

    children.push({ type: "spacer" });
    children.push({ type: "stats-grid", items: stats });
    children.push({ type: "spacer" });

    // Actions
    var actions = [];
    if (t.external_urls && t.external_urls.spotify) {
      actions.push({ type: "button", label: "Open in Spotify", action: "open-spotify-url" });
    }
    if (t.preview_url) {
      actions.push({ type: "button", label: "Play Preview", action: "play-preview" });
    }
    if (actions.length > 0) {
      children.push({ type: "layout", direction: "horizontal", children: actions });
    }

    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  function renderLoading(message) {
    api.ui.setViewData("spotify", { type: "loading", message: message });
  }

  function renderError(message) {
    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: [
        { type: "text", content: "<p>" + escapeHtml(message) + "</p>" },
        { type: "button", label: "Back", action: "go-home" },
      ],
    });
  }

  function renderSettings() {
    var children = [
      { type: "button", label: "\u2190 Back", action: "go-home" },
      { type: "spacer" },
      { type: "text", content: "<h2>Spotify Settings</h2>" },
      { type: "spacer" },
      { type: "text", content: "<h3>Personalized Feed</h3>" },
      { type: "text", content: "<p style='opacity:0.7'>To see Discover Weekly, Daily Mixes, and other personalized sections, paste your <b>sp_dc</b> cookie from the Spotify web player.</p>" },
      { type: "text", content: "<p style='opacity:0.5'>How to get it: Open <b>open.spotify.com</b> in your browser &rarr; log in &rarr; open Developer Tools (F12) &rarr; Application tab &rarr; Cookies &rarr; copy the <b>sp_dc</b> value.</p>" },
      { type: "spacer" },
    ];

    if (state.spDcCookie) {
      children.push({ type: "text", content: "<p>Cookie: <b>" + escapeHtml(state.spDcCookie.substring(0, 12) + "...") + "</b></p>" });
      children.push({
        type: "layout",
        direction: "horizontal",
        children: [
          { type: "button", label: "Remove Cookie", action: "remove-sp-dc" },
          { type: "button", label: "Test Connection", action: "test-sp-dc" },
        ],
      });
    } else {
      children.push({ type: "search-input", placeholder: "Paste sp_dc cookie value here...", action: "save-sp-dc", value: "" });
    }

    api.ui.setViewData("spotify", {
      type: "layout",
      direction: "vertical",
      children: children,
    });
  }

  // -- Action handlers --

  api.ui.onAction("start-auth", function () {
    startAuth();
  });

  api.ui.onAction("go-home", function () {
    if (state.accessToken || state.refreshToken) {
      loadHome();
    } else {
      renderSetup();
    }
  });

  api.ui.onAction("refresh-home", function () {
    loadHome();
  });

  api.ui.onAction("view-liked", function () {
    loadLikedTracks(0);
  });

  api.ui.onAction("liked-prev", function () {
    loadLikedTracks(Math.max(0, state.likedOffset - 50));
  });

  api.ui.onAction("liked-next", function () {
    loadLikedTracks(state.likedOffset + 50);
  });

  function findPlaylistById(playlistId) {
    // Check user's playlists first
    for (var i = 0; i < state.playlists.length; i++) {
      if (state.playlists[i].id === playlistId) {
        return state.playlists[i];
      }
    }
    // Check personalized home feed sections
    for (var s = 0; s < state.homeSections.length; s++) {
      var section = state.homeSections[s];
      for (var j = 0; j < section.items.length; j++) {
        var item = section.items[j];
        if (item.type === "playlist" && item.id === playlistId) {
          // Construct a playlist-like object from the home feed item
          return {
            id: item.id,
            name: item.name,
            images: item.imageUrl ? [{ url: item.imageUrl }] : [],
            tracks: { total: 0 },
          };
        }
      }
    }
    return null;
  }

  api.ui.onAction("view-playlist", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "playlist" || !parts[1]) return;
    var playlistId = parts.slice(1).join(":");
    var playlist = findPlaylistById(playlistId);
    if (playlist) loadPlaylistTracks(playlist, 0);
  });

  api.ui.onAction("open-spotify-uri", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "uri" || !parts[1]) return;
    var uri = parts.slice(1).join(":");
    // Convert spotify:album:xyz to https://open.spotify.com/album/xyz
    var uriParts = uri.split(":");
    if (uriParts.length >= 3 && uriParts[0] === "spotify") {
      var webUrl = "https://open.spotify.com/" + uriParts[1] + "/" + uriParts[2];
      api.network.openUrl(webUrl);
    }
  });

  api.ui.onAction("playlist-prev", function () {
    if (state.currentPlaylist) {
      loadPlaylistTracks(state.currentPlaylist, Math.max(0, state.playlistTracksOffset - 50));
    }
  });

  api.ui.onAction("playlist-next", function () {
    if (state.currentPlaylist) {
      loadPlaylistTracks(state.currentPlaylist, state.playlistTracksOffset + 50);
    }
  });

  api.ui.onAction("search", function (data) {
    var query = data && data.query;
    if (query) searchSpotify(query);
  });

  api.ui.onAction("search-tab", function (data) {
    if (data && data.tabId) {
      state.searchTab = data.tabId;
      renderSearch();
    }
  });

  api.ui.onAction("view-track", function (data) {
    if (!data || !data.itemId) return;
    var parts = data.itemId.split(":");
    if (parts[0] !== "track" || !parts[1]) return;
    var trackId = parts.slice(1).join(":");
    loadTrackDetail(trackId);
  });

  api.ui.onAction("detail-back", function () {
    // Go back to wherever we came from
    if (state.searchQuery && state.searchResults.tracks.length > 0) {
      state.currentView = "search";
      renderSearch();
    } else if (state.currentPlaylist) {
      state.currentView = "playlist";
      renderPlaylist();
    } else if (state.likedTracks.length > 0) {
      state.currentView = "liked";
      renderLiked();
    } else {
      loadHome();
    }
  });

  api.ui.onAction("open-spotify-url", function () {
    if (state.detailTrack && state.detailTrack.external_urls && state.detailTrack.external_urls.spotify) {
      api.network.openUrl(state.detailTrack.external_urls.spotify);
    }
  });

  api.ui.onAction("play-preview", function () {
    if (state.detailTrack && state.detailTrack.preview_url) {
      api.network.openUrl(state.detailTrack.preview_url);
    }
  });

  api.ui.onAction("disconnect", function () {
    state.accessToken = null;
    state.refreshToken = null;
    state.tokenExpiry = 0;
    state.userName = null;
    state.playlists = [];
    state.homeSections = [];
    state.likedTracks = [];
    api.storage.delete("spotify_tokens");
    api.storage.delete("spotify_user");
    renderSetup("Disconnected from Spotify.");
  });

  api.ui.onAction("show-settings", function () {
    state.currentView = "settings";
    renderSettings();
  });

  api.ui.onAction("save-sp-dc", function (data) {
    var cookie = data && data.query;
    if (!cookie || !cookie.trim()) return;
    state.spDcCookie = cookie.trim();
    state.webPlayerToken = null;
    state.webPlayerTokenExpiry = 0;
    api.storage.set("spotify_sp_dc", state.spDcCookie).then(function () {
      api.ui.showNotification("Cookie saved. Refreshing home feed...");
      renderSettings();
      return loadHome();
    });
  });

  api.ui.onAction("remove-sp-dc", function () {
    state.spDcCookie = null;
    state.webPlayerToken = null;
    state.webPlayerTokenExpiry = 0;
    api.storage.delete("spotify_sp_dc");
    api.ui.showNotification("Cookie removed.");
    renderSettings();
  });

  api.ui.onAction("test-sp-dc", function () {
    if (!state.spDcCookie) return;
    renderLoading("Testing sp_dc cookie...");
    ensureWebPlayerToken().then(function (token) {
      if (token) {
        api.ui.showNotification("Cookie is valid! Web player token acquired.");
      } else {
        api.ui.showNotification("Cookie is invalid or expired. Please paste a fresh one.");
      }
      renderSettings();
    });
  });

  // -- Initialize --
  console.log("[spotify] plugin activate: initializing...");

  api.storage.get("spotify_tokens").then(function (tokens) {
    console.log("[spotify] init: stored tokens=" + (tokens ? "found" : "none"));
    if (tokens) {
      state.accessToken = tokens.accessToken;
      state.refreshToken = tokens.refreshToken;
      state.tokenExpiry = tokens.tokenExpiry || 0;
    }
    return api.storage.get("spotify_user");
  }).then(function (user) {
    state.userName = user || null;
    return api.storage.get("spotify_sp_dc");
  }).then(function (spDc) {
    if (spDc) {
      state.spDcCookie = spDc;
      console.log("[spotify] init: sp_dc cookie loaded from storage");
    }
    if (state.accessToken || state.refreshToken) {
      return loadHome();
    } else {
      renderSetup();
    }
  });
}

function deactivate() {
  // Nothing to clean up
}

return { activate: activate, deactivate: deactivate };
